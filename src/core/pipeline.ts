import type { BriefConfig, Item, RawItem, Recipient, Schedule, Section } from '../config/schema'
import { resolveRecipients, resolveSections } from '../config/schema'
import { findRunByCron, findScheduleById, ScheduleError } from '../schedule/cron'
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
import { enrichSections, type EnrichStats } from '../enrich'
import { collectWeekly, describeWindow, weeklySchedule, type WeeklyWindow } from './weekly'
import type { LlmFetch } from '../enrich/llm'
import type { ExtractFetch } from '../enrich/extract'

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
  /**
   * §9 M3 — the weekly review: read `weekly.days` of archived issues, re-rank them, send.
   * Fetches nothing and archives nothing, because everything it prints is already in the
   * archive it just read.
   */
  weekly?: boolean
  /** `YYYY-MM-DD` the weekly window ends on; defaults to today in the config timezone. */
  weeklyEnding?: string
  dryRun: boolean
  /** Suppress the archive write regardless of config (`--no-commit` implies nothing here). */
  noArchive?: boolean
  fetchImpl: FetchLike
  /** POST-capable seam for the LLM endpoint; defaults to `fetchImpl` widened. */
  llmFetchImpl?: LlmFetch
  /**
   * §9 M2 — seam for reading the linked articles. It needs response headers and manual
   * redirects, which `FetchLike` does not expose, so it is its own option rather than a
   * cast of `fetchImpl`; unset simply means no article is fetched.
   */
  extractFetchImpl?: ExtractFetch
  /** `--no-llm` — the brief must still go out when the model is down or unpaid. */
  noLlm?: boolean
  /** `--llm-dry-run` — plan the calls, print them, make none. */
  llmDryRun?: boolean
  /** Injected so a retry backoff costs the tests nothing. */
  sleep?: (ms: number) => Promise<void>
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
  /** §6.1 — reported, never fatal. `--from-archive` reports `disabled`: a re-send re-sends. */
  enrich: EnrichStats
  /** §9 M3 — what the weekly review actually read; `null` on every other run. */
  weekly: WeeklyWindow | null
  empty: boolean
  exitCode: number
}

/** With one schedule there is nothing to disambiguate; with several, the caller must say which. */
export function resolveSchedule(options: RunOptions): Schedule {
  const { config } = options
  // `--weekly` and the weekly cron both land here; the derived schedule is what carries
  // the weekly's own section and recipient lists into the rest of the run.
  if (options.weekly) return weeklySchedule(config)
  if (options.scheduleId) return findScheduleById(config, options.scheduleId)
  if (options.cron && options.cron.trim() !== '')
    return findRunByCron(config, options.cron).schedule

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
    // A re-send re-sends what was written that morning, 导读 included — regenerating it
    // would make the second copy differ from the one already on the public site.
    ...(record.digest ? { digest: record.digest } : {}),
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
  let enrich: EnrichStats = {
    status: 'disabled',
    model: config.llm.provider.model,
    planned: 0,
    gated: 0,
    cappedByItems: 0,
    cappedByChars: 0,
    succeeded: 0,
    failed: 0,
    fullText: 0,
    fullTextFailed: 0,
    fetchDurationMs: 0,
    attempts: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedInputTokens: 0,
    digest: 'off',
    estimatedDigestTokens: 0,
    durationMs: 0,
  }
  let weekly: WeeklyWindow | null = null

  if (options.weekly) {
    // §9 M3 — zero fetches: the week is assembled out of the archives the daily runs
    // already committed, summaries and all.
    const date = options.weeklyEnding ?? localDate(now, config.timezone)
    const collected = collectWeekly(
      config,
      date,
      sections.map((s) => s.id),
      fs,
    )
    weekly = collected.window
    log(`weekly: ${describeWindow(collected.window)}`)

    // The only model call a weekly can make is the digest: every item already carries the
    // summary the morning run paid for, and paying again would buy the same sentence.
    // `weekly.digest` can turn even that off without touching the daily's own digest.
    const weeklyLlm = {
      ...config.llm,
      digest: { ...config.llm.digest, enabled: config.llm.digest.enabled && config.weekly.digest },
    }
    const enriched = await enrichSections(collected.sections, weeklyLlm, {
      env,
      fetchImpl: (options.llmFetchImpl ?? (options.fetchImpl as unknown as LlmFetch)) as LlmFetch,
      sleep: options.sleep,
      disabled: options.noLlm,
      planOnly: options.llmDryRun,
      digestOnly: true,
      describeError,
      log,
    })
    enrich = enriched.stats

    brief = {
      date,
      scheduleId: schedule.id,
      slot: null,
      title: config.weekly.title,
      timezone: config.timezone,
      generatedAt: now.toISOString(),
      lookbackHours: schedule.lookbackHours,
      sections: enriched.sections,
      ...(enriched.digest ? { digest: enriched.digest } : {}),
      warnings: enriched.warnings,
    }
  } else if (options.fromArchive) {
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

    // §1.1 — after selection so `section.limit` caps the spend, before the brief is
    // built so the summaries reach the archive and every renderer for free.
    const enriched = await enrichSections(built, config.llm, {
      env,
      fetchImpl: (options.llmFetchImpl ?? (options.fetchImpl as unknown as LlmFetch)) as LlmFetch,
      extractFetchImpl: options.extractFetchImpl,
      sleep: options.sleep,
      disabled: options.noLlm,
      planOnly: options.llmDryRun,
      describeError,
      log,
    })
    enrich = enriched.stats
    warnings.push(...enriched.warnings)

    brief = {
      date: localDate(now, config.timezone),
      scheduleId: schedule.id,
      slot: slotFor(config, schedule),
      title: config.title,
      timezone: config.timezone,
      generatedAt: now.toISOString(),
      lookbackHours: schedule.lookbackHours,
      sections: enriched.sections,
      ...(enriched.digest ? { digest: enriched.digest } : {}),
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
      enrich,
      weekly,
      empty: true,
      exitCode: 0,
    }
  }

  // §3.2 — archive BEFORE pushing: a flaky channel must not take the content down with it.
  let archived: RunResult['archived'] = null
  const shouldArchive =
    config.archive.enabled &&
    !options.dryRun &&
    !options.noArchive &&
    !options.fromArchive &&
    // A weekly writes nothing: every item in it is already archived under its own day,
    // and a second copy would collide with that day's file and skew cross-day dedupe.
    !options.weekly
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

  const rendered = renderForRecipients(brief, recipients, config.render, config.llm.digest)
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
    enrich,
    weekly,
    empty: false,
    exitCode: failed > 0 ? 1 : 0,
  }
}

export type { Recipient }
