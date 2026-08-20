import type { BriefConfig, Schedule } from '../config/schema'

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

export interface GeneratedCron {
  schedule: Schedule
  cron: string
  comment: string
  enabled: boolean
}

export function generateCrons(config: BriefConfig): GeneratedCron[] {
  const dst = hasDst(config.timezone)
  return config.schedules.map((schedule) => {
    const parts = localTimeToUtcCron(schedule.time, config.timezone)
    const shift =
      parts.dayShift === 0 ? '' : parts.dayShift > 0 ? ' (next UTC day)' : ' (previous UTC day)'
    const dstNote = dst ? ' — WARNING: timezone observes DST, this drifts by 1h twice a year' : ''
    return {
      schedule,
      cron: parts.cron,
      comment: `${schedule.id} - ${schedule.time} ${config.timezone}${shift}${dstNote}`,
      enabled: schedule.enabled,
    }
  })
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
export function findScheduleByCron(config: BriefConfig, cron: string): Schedule {
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
  return matches[0]!.schedule
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
export function renderScheduleBlock(config: BriefConfig, indent = '    '): string {
  const lines: string[] = []
  lines.push(`${indent}${SCHEDULE_BEGIN}`)
  lines.push(
    `${indent}# generated from brief.config.yaml - run \`pnpm brief:schedule\` after editing, do not hand-edit`,
  )
  const crons = generateCrons(config)
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
export function applyScheduleBlock(workflowYaml: string, config: BriefConfig): string {
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
  const block = renderScheduleBlock(config, indent)
  return [...lines.slice(0, beginAt), ...block.split('\n'), ...lines.slice(endAt + 1)].join('\n')
}
