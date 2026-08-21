import type { BriefConfig, Item, RawItem, Recipient, Schedule, Section } from '../config/schema'
import { resolveRecipients, resolveSections } from '../config/schema'
import { findScheduleByCron, findScheduleById, ScheduleError } from '../schedule/cron'
import { fetchAll, type FetchLike, type SourceOutcome } from '../sources'
import { dedupe, seenFromArchive, emptySeen } from './dedupe'
import { filterForSection, minScoreBySource } from './filter'
import { healthWarnings } from './health'
import { rank, selectForSection, weightsOf } from './rank'
import { localDate, totalItems, type Brief, type BriefSection } from './brief'
import { collectSecretValues, safeErrorMessage } from './redact'
import { readRecentItems, readRecord } from '../archive/read'
import { writeArchive } from '../archive/write'
import { nodeFs, type FsLike } from '../archive/fs'
import { renderForRecipients } from '../render'
import { deliver, type ChannelContext, type DeliveryResult } from '../channels'

export interface RunOptions {
  config: BriefConfig
  configHash: string
  now: Date
  env: NodeJS.ProcessEnv
  /** Which schedule to run — by id, or reverse-looked-up from the firing cron. */
  scheduleId?: string
  cron?: string
  /** CLI overrides, intersected with the schedule's own lists. */
  sections?: string[]
  recipients?: string[]
  /** `YYYY-MM-DD` — re-send an archived issue without fetching anything (A14). */
  fromArchive?: string
  dryRun: boolean
  /** Suppress the archive write regardless of config (`--no-commit` implies nothing here). */
  noArchive?: boolean
  fetchImpl: FetchLike
  channelContext: ChannelContext
  fs?: FsLike
  timeoutMs?: number
  log?: (message: string) => void
}

export interface RunResult {
  schedule: Schedule
  brief: Brief
  sources: SourceOutcome[]
  deliveries: DeliveryResult[]
  archived: { markdownPath: string; jsonPath: string; indexPath: string } | null
  dedupeDropped: { withinRun: number; alreadySeen: number }
  empty: boolean
  exitCode: number
}

/** With one schedule there is nothing to disambiguate; with several, the caller must say which. */
export function resolveSchedule(options: RunOptions): Schedule {
  const { config } = options
  if (options.scheduleId) return findScheduleById(config, options.scheduleId)
  if (options.cron && options.cron.trim() !== '') return findScheduleByCron(config, options.cron)

  const enabled = config.schedules.filter((s) => s.enabled)
  if (enabled.length === 1) return enabled[0]!
  throw new ScheduleError(
    enabled.length === 0
      ? 'No enabled schedule in brief.config.yaml.'
      : `brief.config.yaml has ${enabled.length} enabled schedules ` +
          `(${enabled.map((s) => s.id).join(', ')}); pass --schedule <id> or --cron "<cron>".`,
  )
}

function intersect(list: string[], override: string[] | undefined): string[] {
  if (!override || override.length === 0) return list
  if (list.includes('*')) return override
  return list.filter((id) => override.includes(id))
}

/** Rebuild a Brief out of an archived record — the `--from-archive` path. */
function briefFromArchive(options: RunOptions, schedule: Schedule, sections: Section[]): Brief {
  const date = options.fromArchive!
  const archive = options.config.archive
  const fs = options.fs ?? nodeFs
  const slot = slotFor(options.config, schedule)
  const record = readRecord(archive.dir, date, slot, fs) ?? readRecord(archive.dir, date, null, fs)
  if (!record) {
    throw new Error(
      `No archived issue for ${date}${slot ? ` (${slot})` : ''} under ${archive.dir}/. ` +
        `Nothing to re-send.`,
    )
  }
  const byId = new Map(sections.map((s) => [s.id, [] as Item[]]))
  for (const item of record.items) {
    byId.get(item.section)?.push(item)
  }
  return {
    date: record.date,
    scheduleId: record.scheduleId,
    slot: record.slot,
    title: options.config.title,
    timezone: record.timezone,
    generatedAt: record.generatedAt,
    lookbackHours: record.lookbackHours,
    sections: sections.map((s) => ({ id: s.id, title: s.title, items: byId.get(s.id) ?? [] })),
    warnings: record.warnings,
  }
}

/** Archive filenames only carry a slot suffix once more than one schedule is live (§3.6). */
export function slotFor(config: BriefConfig, schedule: Schedule): string | null {
  return config.schedules.filter((s) => s.enabled).length > 1 ? schedule.id : null
}

export async function run(options: RunOptions): Promise<RunResult> {
  const { config, now, env } = options
  const fs = options.fs ?? nodeFs
  const log = options.log ?? (() => {})
  const secrets = collectSecretValues(env)
  const describeError = (err: unknown) => safeErrorMessage(err, secrets)

  const schedule = resolveSchedule(options)
  // A disabled section is skipped even when the schedule or `--sections` names it, exactly
  // as a disabled recipient is — the flag is the editorial decision, the list is routing.
  const sections = resolveSections(
    intersect(schedule.sections, options.sections),
    config.sections,
  ).filter((s) => s.enabled)
  const recipients = resolveRecipients(
    intersect(schedule.recipients, options.recipients),
    config.recipients,
  ).filter((r) => r.enabled)

  if (sections.length === 0) throw new Error('No sections selected — nothing to build.')

  let brief: Brief
  let sourceOutcomes: SourceOutcome[] = []
  let dedupeDropped = { withinRun: 0, alreadySeen: 0 }

  if (options.fromArchive) {
    brief = briefFromArchive(options, schedule, sections)
    log(`re-sending archived issue ${brief.date}${brief.slot ? `.${brief.slot}` : ''}`)
  } else {
    const needed = new Set(sections.flatMap((s) => s.sources))
    const sources = config.sources.filter((s) => needed.has(s.name))

    sourceOutcomes = await fetchAll(sources, {
      now,
      env,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs ?? 20_000,
      excerptMaxChars: config.render.excerptMaxChars,
      onError: (_name, err) => describeError(err),
    })

    const warnings = [
      ...sourceOutcomes
        .filter((o) => o.error)
        .map((o) => `source "${o.source}" failed: ${o.error}`),
      // A source can also fail by NOT failing — 200 + stale content (§3.2, core/health.ts).
      ...healthWarnings(sourceOutcomes, sources, now),
    ]

    // Higher-weight sources first, so the surviving copy of a cross-posted story is the
    // one from the source we trust more.
    const weights = weightsOf(config.sources)
    const fetched: RawItem[] = sourceOutcomes
      .flatMap((o) => o.items)
      .sort((a, b) => (weights[b.source] ?? 1) - (weights[a.source] ?? 1))

    const seen = config.archive.enabled
      ? seenFromArchive(
          readRecentItems(
            config.archive.dir,
            localDate(now, config.timezone),
            config.archive.dedupeLookbackDays,
            fs,
          ).items,
        )
      : emptySeen()

    const deduped = dedupe(fetched, seen, config.dedupe.titleSimilarity)
    dedupeDropped = { withinRun: deduped.droppedWithinRun, alreadySeen: deduped.droppedAsSeen }

    const floors = minScoreBySource(config.sources)
    const used = new Set<string>()
    const built: BriefSection[] = []

    for (const section of sections) {
      const candidates = filterForSection(
        deduped.items.filter((i) => !used.has(i.id)),
        section,
        { now, lookbackHours: schedule.lookbackHours, minScoreBySource: floors },
      )
      const ranked = rank(candidates, section.id, {
        now,
        lookbackHours: schedule.lookbackHours,
        weights,
      })
      const chosen = selectForSection(ranked, section)
      chosen.forEach((item) => used.add(item.id))
      built.push({ id: section.id, title: section.title, items: chosen })
    }

    brief = {
      date: localDate(now, config.timezone),
      scheduleId: schedule.id,
      slot: slotFor(config, schedule),
      title: config.title,
      timezone: config.timezone,
      generatedAt: now.toISOString(),
      lookbackHours: schedule.lookbackHours,
      sections: built,
      warnings,
    }
  }

  const count = totalItems(brief)

  // §3.2 — nothing worth sending means nothing is sent and nothing is archived, so an
  // empty morning does not train you to ignore the brief.
  if (count === 0) {
    return {
      schedule,
      brief,
      sources: sourceOutcomes,
      deliveries: [],
      archived: null,
      dedupeDropped,
      empty: true,
      exitCode: 0,
    }
  }

  // §3.2 — archive BEFORE pushing: a flaky channel must not take the content down with it.
  let archived: RunResult['archived'] = null
  const shouldArchive =
    config.archive.enabled && !options.dryRun && !options.noArchive && !options.fromArchive
  if (shouldArchive) {
    const written = writeArchive({
      brief,
      archive: config.archive,
      configHash: options.configHash,
      scheduleId: schedule.id,
      now,
      fs,
      secretValues: secrets,
    })
    archived = {
      markdownPath: written.markdownPath,
      jsonPath: written.jsonPath,
      indexPath: written.indexPath,
    }
    log(`archived ${written.markdownPath}`)
  }

  const rendered = renderForRecipients(brief, recipients)
  const payloads = new Map<
    string,
    { title: string; body: string; blocks: string[]; text: string }
  >()
  for (const recipient of recipients) {
    const r = rendered.get(recipient.id)
    if (!r) continue
    payloads.set(recipient.id, {
      title: `${brief.title} · ${brief.date}`,
      body: r.body,
      blocks: r.blocks,
      text: r.text,
    })
  }

  const deliveries = await deliver(recipients, {
    ctx: options.channelContext,
    payloads,
    dryRun: options.dryRun,
    describeError,
  })

  const failed = deliveries.filter((d) => d.status === 'failed').length
  return {
    schedule,
    brief,
    sources: sourceOutcomes,
    deliveries,
    archived,
    dedupeDropped,
    empty: false,
    exitCode: failed > 0 ? 1 : 0,
  }
}

export type { Recipient }
