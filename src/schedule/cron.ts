import type { BriefConfig, PublishSchedule, Schedule, Weekday } from '../config/schema'
import { weeklySchedule } from '../core/weekly'

/**
 * §3.6 / decision 7 — `on.schedule.cron` must be a literal in the workflow YAML:
 * the `on:` block supports no expressions, so it can read neither vars nor
 * brief.config.yaml. The config stays the single source of truth and the cron is
 * *generated* from it, with `pnpm check:schedule` guarding the drift.
 */

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleError'
  }
}

/** Offset of `timeZone` from UTC, in minutes, at instant `at` (east of UTC is positive). */
export function tzOffsetMinutes(timeZone: string, at: Date): number {
  let formatted: string
  try {
    formatted = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).format(
      at,
    )
  } catch {
    throw new ScheduleError(
      `Unknown timezone "${timeZone}" (must be an IANA zone, e.g. Asia/Shanghai)`,
    )
  }
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(formatted)
  if (!match) return 0 // "GMT" with no offset = UTC
  const sign = match[1] === '-' ? -1 : 1
  const hours = Number(match[2])
  const minutes = Number(match[3] ?? '0')
  return sign * (hours * 60 + minutes)
}

/** Does this zone shift its offset during the year? A generated cron would be wrong half of it. */
export function hasDst(timeZone: string, year = 2026): boolean {
  const jan = tzOffsetMinutes(timeZone, new Date(Date.UTC(year, 0, 15, 12)))
  const jul = tzOffsetMinutes(timeZone, new Date(Date.UTC(year, 6, 15, 12)))
  return jan !== jul
}

export function parseLocalTime(time: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!match) throw new ScheduleError(`Invalid time "${time}" — expected 'HH:MM' (24h)`)
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

export interface CronParts {
  cron: string
  /** UTC hour/minute the cron fires at. */
  utcHour: number
  utcMinute: number
  /** -1 = fires the previous UTC day, +1 = the next; daily crons don't care, but the comment does. */
  dayShift: number
}

/**
 * Local wall-clock time → daily UTC cron.
 * The day may shift across the date line; for a daily `* * *` cron that is harmless,
 * but it is reported so the generated comment can say so.
 */
export function localTimeToUtcCron(
  time: string,
  timeZone: string,
  reference = new Date(Date.UTC(2026, 0, 15, 12)),
): CronParts {
  const { hour, minute } = parseLocalTime(time)
  const offset = tzOffsetMinutes(timeZone, reference)
  const totalUtc = hour * 60 + minute - offset
  const dayMinutes = 24 * 60
  const dayShift = Math.floor(totalUtc / dayMinutes)
  const normalized = ((totalUtc % dayMinutes) + dayMinutes) % dayMinutes
  const utcHour = Math.floor(normalized / 60)
  const utcMinute = normalized % 60
  return { cron: `${utcMinute} ${utcHour} * * *`, utcHour, utcMinute, dayShift }
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * §9 M3 — the weekly review's cron. Local wall-clock weekday + time → a UTC day-of-week
 * cron. The day-of-week has to move with the same `dayShift` the time does: 07:10 Monday
 * in Asia/Shanghai is 23:10 **Sunday** UTC, and a cron that still said Monday would send
 * the review 24 hours late every week.
 *
 * `weekday` is ISO (1 = Monday … 7 = Sunday); cron counts 0 = Sunday, hence the `% 7`.
 */
export function weeklyToUtcCron(
  time: string,
  weekday: number,
  timeZone: string,
  reference?: Date,
): CronParts & { utcWeekday: number } {
  const parts = localTimeToUtcCron(time, timeZone, reference)
  const utcWeekday = ((((weekday % 7) + parts.dayShift) % 7) + 7) % 7
  return {
    ...parts,
    utcWeekday,
    cron: `${parts.utcMinute} ${parts.utcHour} * * ${utcWeekday}`,
  }
}

export interface GeneratedCron {
  schedule: Schedule
  cron: string
  comment: string
  enabled: boolean
  /** §9 M3 — the weekly review rather than one of `schedules[]`. */
  weekly: boolean
}

export function generateCrons(config: BriefConfig): GeneratedCron[] {
  const dst = hasDst(config.timezone)
  const dstNote = dst ? ' — WARNING: timezone observes DST, this drifts by 1h twice a year' : ''
  const shiftNote = (dayShift: number) =>
    dayShift === 0 ? '' : dayShift > 0 ? ' (next UTC day)' : ' (previous UTC day)'

  const daily = config.schedules.map((schedule): GeneratedCron => {
    const parts = localTimeToUtcCron(schedule.time, config.timezone)
    return {
      schedule,
      cron: parts.cron,
      comment: `${schedule.id} - ${schedule.time} ${config.timezone}${shiftNote(parts.dayShift)}${dstNote}`,
      enabled: schedule.enabled,
      weekly: false,
    }
  })

  const weekly = weeklyToUtcCron(config.weekly.time, config.weekly.weekday, config.timezone)
  const localDay = WEEKDAY_NAMES[config.weekly.weekday % 7]!
  daily.push({
    schedule: weeklySchedule(config),
    cron: weekly.cron,
    comment:
      `weekly - ${localDay} ${config.weekly.time} ${config.timezone}` +
      `${shiftNote(weekly.dayShift)}${dstNote}`,
    enabled: config.weekly.enabled,
    weekly: true,
  })
  return daily
}

/* ───────────── PUBLISH.md §7.2 — the same generator, for the publish workflow ───────────── */

/**
 * There are now TWO workflows carrying generated crons, and A17's reason for the drift
 * guard doubles with them: "changed the time, forgot to regenerate" fails silently and
 * the only symptom is a brief that never arrives. `pnpm check:schedule` covers both.
 */
export type ScheduleKind = 'brief' | 'publish'

export const WORKFLOWS: Record<ScheduleKind, string> = {
  brief: '.github/workflows/daily-brief.yml',
  publish: '.github/workflows/publish.yml',
}

/** The npm script that regenerates each — printed into the generated block itself. */
const REGENERATE_SCRIPT: Record<ScheduleKind, string> = {
  brief: 'pnpm brief:schedule',
  publish: 'pnpm publish:schedule',
}

/** ISO weekday of the config's spelling; `weeklyToUtcCron` counts 1 = Monday … 7 = Sunday. */
const ISO_WEEKDAY: Record<Weekday, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
}

export interface GeneratedPublishCron {
  schedule: PublishSchedule
  cron: string
  comment: string
  enabled: boolean
}

/**
 * `publish.schedules[]` → crons. A line with a `weekday` goes through the very same
 * `weeklyToUtcCron` the weekly review uses, day-shift included: 10:30 Monday in
 * Asia/Shanghai is 02:30 Monday UTC here, but the shift logic is what keeps it correct
 * for any zone rather than for this one.
 */
export function generatePublishCrons(config: BriefConfig): GeneratedPublishCron[] {
  const dst = hasDst(config.timezone)
  const dstNote = dst ? ' — WARNING: timezone observes DST, this drifts by 1h twice a year' : ''
  const shiftNote = (dayShift: number) =>
    dayShift === 0 ? '' : dayShift > 0 ? ' (next UTC day)' : ' (previous UTC day)'

  return config.publish.schedules.map((schedule): GeneratedPublishCron => {
    if (schedule.weekday) {
      const parts = weeklyToUtcCron(schedule.time, ISO_WEEKDAY[schedule.weekday], config.timezone)
      const localDay = WEEKDAY_NAMES[ISO_WEEKDAY[schedule.weekday] % 7]!
      return {
        schedule,
        cron: parts.cron,
        comment:
          `${schedule.id} - ${localDay} ${schedule.time} ${config.timezone}` +
          `${shiftNote(parts.dayShift)}${dstNote}`,
        // A globally disabled publish block must not leave live crons behind.
        enabled: schedule.enabled && config.publish.enabled,
      }
    }
    const parts = localTimeToUtcCron(schedule.time, config.timezone)
    return {
      schedule,
      cron: parts.cron,
      comment: `${schedule.id} - ${schedule.time} ${config.timezone}${shiftNote(parts.dayShift)}${dstNote}`,
      enabled: schedule.enabled && config.publish.enabled,
    }
  })
}

/** The kind-agnostic view the renderer and the drift check work on. */
interface CronEntry {
  id: string
  cron: string
  comment: string
  enabled: boolean
}

function entriesFor(config: BriefConfig, kind: ScheduleKind): CronEntry[] {
  if (kind === 'publish') {
    return generatePublishCrons(config).map((c) => ({
      id: c.schedule.id,
      cron: c.cron,
      comment: c.comment,
      enabled: c.enabled,
    }))
  }
  return generateCrons(config).map((c) => ({
    id: c.schedule.id,
    cron: c.cron,
    comment: c.comment,
    enabled: c.enabled,
  }))
}

/** Which publishing line fired, given the cron GitHub reports. A miss is an error (A19). */
export function findPublishScheduleByCron(config: BriefConfig, cron: string): PublishSchedule {
  const wanted = normalizeCron(cron)
  const all = generatePublishCrons(config)
  const matches = all.filter((g) => g.enabled && normalizeCron(g.cron) === wanted)
  if (matches.length === 0) {
    const known = all
      .filter((g) => g.enabled)
      .map((g) => `"${g.cron}" (${g.schedule.id})`)
      .join(', ')
    throw new ScheduleError(
      `No enabled publish schedule in brief.config.yaml generates cron "${wanted}". ` +
        `Known crons: ${known || '(none)'}. ` +
        `Run "pnpm publish:schedule" and commit the regenerated workflow.`,
    )
  }
  if (matches.length > 1) {
    throw new ScheduleError(
      `cron "${wanted}" is ambiguous: publish schedules ${matches
        .map((m) => `"${m.schedule.id}"`)
        .join(', ')} all fire at that time. Give them distinct times.`,
    )
  }
  return matches[0]!.schedule
}

export function findPublishScheduleById(config: BriefConfig, id: string): PublishSchedule {
  const found = config.publish.schedules.find((s) => s.id === id)
  if (!found) {
    throw new ScheduleError(
      `Unknown publish schedule "${id}". Known: ` +
        `${config.publish.schedules.map((s) => s.id).join(', ') || '(none)'}`,
    )
  }
  return found
}

/** Only the literal shapes this file GENERATES: `M H * * *` and `M H * * D`. */
const CRON_LITERAL = /^\d{1,2}$/

/**
 * The instant a cron was MEANT to fire, given the instant the run actually started.
 *
 * GitHub's `schedule` dispatcher is best-effort. Measured on this repo: 23–88 minutes late
 * on a normal day, and 5–10 HOURS late across the 2026-08-26 Actions incident. The run's
 * own clock is therefore not the edition's identity — anchoring the date to it filed
 * 2026-08-27's evening issue as `2026-08-28.evening`, where the next day's real evening
 * run would have overwritten it. Walking back to the most recent occurrence of the cron
 * keeps "one cron firing = one (date, slot)" total for any lag under 24 hours.
 *
 * Freshness is NOT anchored here: `now` stays wall-clock, so a late issue still carries
 * the newest items rather than honouring a stale window.
 *
 * Returns null for any cron this file would not have generated, so callers fall back to
 * wall clock rather than guessing.
 */
export function lastCronOccurrence(cron: string, at: Date): Date | null {
  const fields = normalizeCron(cron).split(' ')
  if (fields.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ]
  if (dayOfMonth !== '*' || month !== '*') return null
  if (!CRON_LITERAL.test(minute) || !CRON_LITERAL.test(hour)) return null
  const m = Number(minute)
  const h = Number(hour)
  if (m > 59 || h > 23) return null
  // cron counts 0 = Sunday and accepts 7 for it too; `* ` means every day.
  let weekday: number | null = null
  if (dayOfWeek !== '*') {
    if (!CRON_LITERAL.test(dayOfWeek)) return null
    const d = Number(dayOfWeek)
    if (d > 7) return null
    weekday = d % 7
  }

  // Seven steps is enough: a daily cron fires every day, a weekly one every 7.
  for (let back = 0; back <= 7; back += 1) {
    const candidate = new Date(
      Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - back, h, m, 0, 0),
    )
    if (candidate.getTime() > at.getTime()) continue
    if (weekday !== null && candidate.getUTCDay() !== weekday) continue
    return candidate
  }
  return null
}

/** Normalize whitespace so `'0  0 * * *'` and `'0 0 * * *'` compare equal. */
export function normalizeCron(cron: string): string {
  return cron.trim().replace(/\s+/g, ' ')
}

/**
 * GitHub puts the firing cron string into `github.event.schedule`; the workflow passes it
 * through as `--cron` and we look up which of our schedules it belongs to.
 * A miss is an error, never a guessed default (A19).
 */
export function findRunByCron(
  config: BriefConfig,
  cron: string,
): { schedule: Schedule; weekly: boolean } {
  const wanted = normalizeCron(cron)
  const matches = generateCrons(config).filter((g) => g.enabled && normalizeCron(g.cron) === wanted)
  if (matches.length === 0) {
    const known = generateCrons(config)
      .filter((g) => g.enabled)
      .map((g) => `"${g.cron}" (${g.schedule.id})`)
      .join(', ')
    throw new ScheduleError(
      `No enabled schedule in brief.config.yaml generates cron "${wanted}". ` +
        `Known crons: ${known || '(none)'}. ` +
        `The workflow is out of sync with the config — run "pnpm brief:schedule" and commit the result.`,
    )
  }
  if (matches.length > 1) {
    throw new ScheduleError(
      `cron "${wanted}" is ambiguous: schedules ${matches
        .map((m) => `"${m.schedule.id}"`)
        .join(', ')} all fire at that time. Give them distinct times.`,
    )
  }
  return { schedule: matches[0]!.schedule, weekly: matches[0]!.weekly }
}

/** The daily-only view of the lookup, kept because most callers cannot run a weekly. */
export function findScheduleByCron(config: BriefConfig, cron: string): Schedule {
  return findRunByCron(config, cron).schedule
}

export function findScheduleById(config: BriefConfig, id: string): Schedule {
  const found = config.schedules.find((s) => s.id === id)
  if (!found) {
    throw new ScheduleError(
      `Unknown schedule "${id}". Known: ${config.schedules.map((s) => s.id).join(', ')}`,
    )
  }
  return found
}

export const SCHEDULE_BEGIN = '# BEGIN generated schedule'
export const SCHEDULE_END = '# END generated schedule'

/**
 * Render the `on.schedule` cron list. Indented to sit under `  schedule:` in the workflow.
 * Disabled schedules are emitted commented-out so the file still documents them.
 */
export function renderScheduleBlock(
  config: BriefConfig,
  indent = '    ',
  kind: ScheduleKind = 'brief',
): string {
  const lines: string[] = []
  lines.push(`${indent}${SCHEDULE_BEGIN}`)
  lines.push(
    `${indent}# generated from brief.config.yaml - run \`${REGENERATE_SCRIPT[kind]}\` after editing, do not hand-edit`,
  )
  const crons = entriesFor(config, kind)
  const enabled = crons.filter((c) => c.enabled)
  if (enabled.length === 0) {
    lines.push(`${indent}# (no enabled schedules - the workflow can only be run manually)`)
  }
  for (const entry of crons) {
    const prefix = entry.enabled ? `- cron: '${entry.cron}'` : `# - cron: '${entry.cron}'`
    const suffix = entry.enabled ? '' : ' [disabled]'
    lines.push(`${indent}${prefix} # ${entry.comment}${suffix}`)
  }
  lines.push(`${indent}${SCHEDULE_END}`)
  return lines.join('\n')
}

/** Replace the marked region of an existing workflow file with a freshly generated block. */
export function applyScheduleBlock(
  workflowYaml: string,
  config: BriefConfig,
  kind: ScheduleKind = 'brief',
): string {
  const lines = workflowYaml.split('\n')
  const beginAt = lines.findIndex((l) => l.trim() === SCHEDULE_BEGIN)
  const endAt = lines.findIndex((l) => l.trim() === SCHEDULE_END)
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    throw new ScheduleError(
      `Workflow file is missing the "${SCHEDULE_BEGIN}" / "${SCHEDULE_END}" markers; ` +
        `cannot generate the schedule safely.`,
    )
  }
  const indent = lines[beginAt]!.slice(0, lines[beginAt]!.indexOf('#'))
  const block = renderScheduleBlock(config, indent, kind)
  return [...lines.slice(0, beginAt), ...block.split('\n'), ...lines.slice(endAt + 1)].join('\n')
}
