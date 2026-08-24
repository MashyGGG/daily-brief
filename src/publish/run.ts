import type { BriefConfig, PublishSchedule, PublishTarget } from '../config/schema'
import { nodeFs, type FsLike } from '../archive/fs'
import { recentDates, shiftDate } from '../archive/paths'
import { localDate } from '../core/brief'
import { collectSecretValues, safeErrorMessage } from '../core/redact'
import { findPublishScheduleById, findPublishScheduleByCron } from '../schedule/cron'
import { adapt, resolveTarget } from './adapt'
import { collect, renderExplain, type CollectResult } from './collect'
import { publishAll, type PublishAttempt } from './index'
import {
  afterFailure,
  afterSuccess,
  publishedItemIds,
  readState,
  setTargetState,
  upsertLine,
  writeState,
  type PublishState,
  type StoredStatus,
} from './state'
import type { PublisherContext, PublishResult } from './types'

/**
 * PUBLISH.md §1.3 / §7.3 — one run of one publishing line.
 *
 * The whole point of reading only the archive is that this is safely re-runnable: it
 * fetches nothing, calls no model, sends no push, and `contentHash` makes a second run a
 * no-op. That is also what makes `catchUpDays` possible: a cron that fires before the
 * brief's archive commit lands is not a failure, it is a day to retry tomorrow.
 */

export interface RunPublishOptions {
  config: BriefConfig
  env: NodeJS.ProcessEnv
  now: Date
  ctx: PublisherContext
  scheduleId?: string
  cron?: string
  /** Publication date; today in the config timezone when unset. */
  date?: string
  targets?: string[]
  catchUp?: number
  dryRun?: boolean
  force?: boolean
  allowPublish?: boolean
  noCommit?: boolean
  explain?: boolean
  fs?: FsLike
  log?: (message: string) => void
}

export interface DayOutcome {
  publishDate: string
  collect: CollectResult
  results: PublishResult[]
  /** Printed under `--explain`. */
  explainText?: string
}

export interface RunPublishResult {
  schedule: PublishSchedule
  days: DayOutcome[]
  /** True when at least one state file changed and the workflow should commit. */
  stateChanged: boolean
  stateLabel: string
  warnings: string[]
  exitCode: number
}

/** Which targets this line publishes to, honouring `--targets`. */
export function targetsFor(
  config: BriefConfig,
  scheduleId: string,
  only?: string[],
): PublishTarget[] {
  return config.publish.targets.filter((target) => {
    if (only && !only.includes(target.id)) return false
    if (!only && !target.enabled) return false
    return target.schedules.includes('*') || target.schedules.includes(scheduleId)
  })
}

/** What the platform holds after a successful attempt (§4.1). */
function storedStatus(result: PublishResult): StoredStatus {
  return result.status === 'published' ? 'published' : 'draft'
}

export async function runPublish(options: RunPublishOptions): Promise<RunPublishResult> {
  const { config, env } = options
  const fs = options.fs ?? nodeFs
  const log = options.log ?? (() => {})
  const secrets = collectSecretValues(env)
  const warnings: string[] = []

  const schedule = options.cron?.trim()
    ? findPublishScheduleByCron(config, options.cron)
    : findPublishScheduleById(config, options.scheduleId ?? 'daily')

  const today = options.date ?? localDate(options.now, config.timezone)
  const catchUp = options.catchUp ?? schedule.catchUpDays
  // Oldest first: a missed day is published before today's, so the platform timeline
  // reads in the order the content was actually about.
  const dates = recentDates(today, catchUp + 1).reverse()

  const targets = targetsFor(config, schedule.id, options.targets)
  if (targets.length === 0) {
    warnings.push(`no target publishes line "${schedule.id}"`)
  }

  const days: DayOutcome[] = []
  let stateChanged = false
  let failures = 0

  for (const publishDate of dates) {
    let state: PublishState | null = readState(config.archive.dir, publishDate, fs)

    // A day that already published everything it was going to is not re-selected: doing
    // so would read the archive for nothing on every catch-up run.
    const done =
      state?.lines[schedule.id] &&
      targets.length > 0 &&
      targets.every((t) => {
        const stored = state!.lines[schedule.id]!.targets[t.id]
        return stored && stored.status !== 'failed'
      })

    // Ids from every OTHER publication — the current (date, line) pair is excluded, or a
    // re-run would exclude its own items, select different ones and never settle.
    const lookback = recentDates(publishDate, config.archive.dedupeLookbackDays).filter(
      (d) => d !== publishDate,
    )
    const published = publishedItemIds(config.archive.dir, lookback, fs)
    for (const [lineId, line] of Object.entries(state?.lines ?? {})) {
      if (lineId === schedule.id) continue
      for (const id of line.itemIds ?? []) published.add(id)
    }

    const selection = collect({
      config,
      schedule,
      publishDate,
      publishedItemIds: published,
      fs,
    })
    const explainText = options.explain ? renderExplain(selection.explain) : undefined

    if (!selection.issue) {
      // §8 — "the archive is not ready yet" is exit 0 on purpose. A cron that lands in an
      // Actions queue once a week would otherwise cry wolf until nobody reads the alerts.
      const detail = `${publishDate} ${schedule.id}: ${selection.detail}`
      if (selection.reason !== 'skip-weekday') warnings.push(detail)
      log(`[publish] ${detail}`)
      days.push({
        publishDate,
        collect: selection,
        results: [],
        ...(explainText ? { explainText } : {}),
      })
      continue
    }

    const issue = selection.issue
    const attempts: PublishAttempt[] = targets.map((target) => {
      const resolved = resolveTarget(target, schedule.id)
      const article = adapt({
        config,
        schedule,
        issue,
        target,
        canonicalBase: env.PUBLISH_CANONICAL_BASE,
        repository: env.GITHUB_REPOSITORY,
      })
      const stored = state?.lines[schedule.id]?.targets[target.id]
      return { target, resolved, article, ...(stored ? { state: stored } : {}) }
    })

    if (
      done &&
      !options.force &&
      attempts.every((a) => a.state?.contentHash === a.article.contentHash)
    ) {
      log(`[publish] ${publishDate} ${schedule.id}: already published, unchanged`)
      days.push({
        publishDate,
        collect: selection,
        results: [],
        ...(explainText ? { explainText } : {}),
      })
      continue
    }

    const outcomes = await publishAll(attempts, {
      ctx: options.ctx,
      ...(options.dryRun ? { dryRun: true } : {}),
      ...(options.force ? { force: true } : {}),
      ...(options.allowPublish ? { allowPublish: true } : {}),
      describeError: (err) => safeErrorMessage(err, secrets),
    })

    const results = outcomes.map((o) => o.result)
    days.push({ publishDate, collect: selection, results, ...(explainText ? { explainText } : {}) })

    // §4.1 — the state is written even when a target failed: `failStreak` is what opens
    // the circuit, and losing it means hammering a rate limiter forever.
    const at = options.now.toISOString()
    let next = upsertLine(state, publishDate, issue, attempts[0]?.article.contentHash ?? '')
    for (const { attempt, result } of outcomes) {
      if (result.status === 'skipped') continue
      if (result.status === 'failed') {
        failures++
        next = setTargetState(
          next,
          schedule.id,
          attempt.target.id,
          afterFailure(attempt.state, {
            platform: attempt.target.platform,
            error: result.detail ?? 'unknown error',
            at,
          }),
        )
        continue
      }
      next = setTargetState(
        next,
        schedule.id,
        attempt.target.id,
        afterSuccess(attempt.state, {
          platform: attempt.target.platform,
          status: storedStatus(result),
          postId: result.postId ?? '',
          ...(result.url ? { url: result.url } : {}),
          contentHash: attempt.article.contentHash,
          at,
        }),
      )
    }

    // A skipped-only day changed nothing worth committing; anything else did.
    const touched = outcomes.some((o) => o.result.status !== 'skipped')
    if (touched && !options.dryRun && !options.noCommit) {
      writeState(config.archive.dir, next, fs, secrets)
      stateChanged = true
    }
    state = next

    for (const { result, decision } of outcomes) {
      if (decision.warn) warnings.push(`${publishDate} ${result.target}: ${decision.reason}`)
    }
  }

  return {
    schedule,
    days,
    stateChanged,
    stateLabel: `${schedule.id} ${dates[0] === today ? today : `${dates[0]} → ${today}`}`,
    warnings,
    exitCode: failures > 0 ? 1 : 0,
  }
}

/** The day before `date` — kept here so `shiftDate`'s sign convention has one reader. */
export function previousDay(date: string): string {
  return shiftDate(date, -1)
}
