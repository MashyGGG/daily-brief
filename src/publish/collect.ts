import type { BriefConfig, Item, PublishSchedule, Weekday } from '../config/schema'
import { NO_SLOT } from '../config/schema'
import { nodeFs, type FsLike } from '../archive/fs'
import { archiveNames, isReprint, parseArchiveFilename, recentDates } from '../archive/paths'
import { parseArchiveRecord, type ArchiveRecord } from '../archive/read'
import type { BriefSection } from '../core/brief'
import type { CollectedIssue } from './types'

/**
 * PUBLISH.md §1.3 — selection.
 *
 * `publish` NEVER re-runs the pipeline: it does not fetch, does not call the model, does
 * not push. But it is not "take one archived issue" either — the two product constraints
 * ("tech only" and "more items than before") cannot both be met out of a single issue,
 * so one publication is REBUILT from an archive window:
 *
 *   1. list the window's archived JSON      (daily: today's slots; weekly: that Monday's)
 *   2. skip reprints the window did not ask for by name
 *   3. section whitelist
 *   4. drop item ids an earlier publication already carried
 *   5. rank desc, cap at maxItems
 *   6. fewer than minItems? backfill, then give up rather than post filler
 *
 * Cross-issue duplication needs no work here: the pipeline's cross-day dedupe already
 * guarantees an item is archived once, so merging morning+evening cannot double up.
 * `publishedItemIds` guards something else — backfill widening the window backwards and
 * re-picking items that went out in an earlier publication.
 */

/** One row of `--explain`: what a single archived issue contributed, and what was dropped. */
export interface CollectExplainRow {
  date: string
  slot: string | null
  /** Items in the file. */
  total: number
  /** Left after the section whitelist. */
  included: number
  /** Dropped because a previous publication already carried them. */
  alreadyPublished: number
  /** Dropped because another file in this window already carried them. */
  duplicate: number
  /** Contributed to the candidate pool. */
  kept: number
  /** True when this file was only read because backfill widened the window. */
  backfill: boolean
}

export interface CollectExplain {
  scheduleId: string
  publishDate: string
  /** The window's dates, newest first, before backfill. */
  window: string[]
  slots: string[]
  include: string[]
  rows: CollectExplainRow[]
  /** Candidates before the `maxItems` cap. */
  candidates: number
  cappedBy: number
  kept: number
  minItems: number
  backfillUsed: boolean
  /** Per section, how many survived — the table that answers "why only 9 today". */
  bySection: Array<{ id: string; title: string; items: number }>
}

export type CollectSkipReason = 'no-archive' | 'too-few-items' | 'skip-weekday'

export interface CollectResult {
  issue: CollectedIssue | null
  /** Set when `issue` is null. */
  reason?: CollectSkipReason
  /** One line, safe to print and to put in a warning. */
  detail?: string
  explain: CollectExplain
}

export interface CollectOptions {
  config: BriefConfig
  schedule: PublishSchedule
  /** The publication date — also the right-hand edge of the window. */
  publishDate: string
  /** Item ids carried by earlier publications of ANY line (§4.1). */
  publishedItemIds?: Iterable<string>
  fs?: FsLike
}

const WEEKDAY_INDEX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** Weekday of a `YYYY-MM-DD`, spelled the way the config spells it. */
export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number)
  return WEEKDAY_INDEX[new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)).getUTCDay()]! as Weekday
}

/** Does this archived file belong to the window? `none` names the slot-less file. */
function slotMatches(slot: string | null, wanted: string[]): boolean {
  return wanted.includes(slot ?? NO_SLOT)
}

/**
 * Chronological rank of an archive slot, taken from the schedule that writes it.
 *
 * Slots must NOT be ordered alphabetically: `evening` sorts before `morning`, which would
 * put the evening issue first in the footer and make it the "newest" issue the canonical
 * URL points at. The times already live in `schedules[]`, so this reads them rather than
 * hard-coding an order that a renamed schedule would silently invert.
 */
export function slotRank(config: BriefConfig, slot: string | null): string {
  if (slot === null) return '00:00'
  const schedule = config.schedules.find((s) => s.id === slot)
  if (schedule) return schedule.time
  if (slot === 'weekly') return config.weekly.time
  return '99:99' // an unknown slot sorts last rather than jumping the queue
}

interface FoundIssue {
  record: ArchiveRecord
  date: string
  slot: string | null
  backfill: boolean
}

/**
 * The window's archived issues, newest first.
 *
 * A reprint (`isReprint`) is skipped unless the window names that slot: a weekly review
 * is filed under the Monday it was sent but holds a week of items, so a daily window
 * reading it would count the same item twice. The weekly LINE, on the other hand, wants
 * exactly that file — hence "unless named".
 */
function findIssues(
  archiveDir: string,
  dates: string[],
  slots: string[],
  fs: FsLike,
  backfill: boolean,
): FoundIssue[] {
  const found: FoundIssue[] = []
  for (const date of dates) {
    const { dir } = archiveNames(archiveDir, date, null)
    for (const name of fs.readdir(dir)) {
      const parsed = parseArchiveFilename(name)
      if (!parsed || parsed.date !== date) continue
      if (!slotMatches(parsed.slot, slots)) continue
      if (isReprint(parsed.slot) && !slots.includes(parsed.slot!)) continue
      const record = parseArchiveRecord(fs.readFile(`${dir}/${name}`) ?? '')
      if (!record) continue
      found.push({ record, date, slot: parsed.slot, backfill })
    }
  }
  return found
}

/** Rank desc, ties broken newest-first so equal scores still read in a sensible order. */
function byRank(a: Item, b: Item): number {
  return b.rankScore - a.rankScore || b.publishedAt.localeCompare(a.publishedAt)
}

export function collect(options: CollectOptions): CollectResult {
  const { config, schedule, publishDate } = options
  const fs = options.fs ?? nodeFs
  const published = new Set(options.publishedItemIds ?? [])
  const slots = schedule.window.slots

  // Only sections that are BOTH whitelisted and real; the order follows the config so a
  // published article reads in the same order as the mail.
  const sections = config.sections.filter((s) => config.publish.include.includes(s.id))
  const allowed = new Set(sections.map((s) => s.id))

  const window = recentDates(publishDate, schedule.window.days)
  const explain: CollectExplain = {
    scheduleId: schedule.id,
    publishDate,
    window,
    slots,
    include: config.publish.include,
    rows: [],
    candidates: 0,
    cappedBy: 0,
    kept: 0,
    minItems: schedule.minItems,
    backfillUsed: false,
    bySection: [],
  }

  const weekday = weekdayOf(publishDate)
  if (schedule.skipWeekdays.includes(weekday)) {
    return {
      issue: null,
      reason: 'skip-weekday',
      detail: `${publishDate} is ${weekday}, listed in this line's skipWeekdays`,
      explain,
    }
  }

  const seen = new Set<string>()
  const candidates: Item[] = []
  const contributed = new Map<string, { date: string; slot: string | null }>()
  let digest: CollectedIssue['digest']

  const absorb = (issues: FoundIssue[]): void => {
    for (const issue of issues) {
      const row: CollectExplainRow = {
        date: issue.date,
        slot: issue.slot,
        total: issue.record.items.length,
        included: 0,
        alreadyPublished: 0,
        duplicate: 0,
        kept: 0,
        backfill: issue.backfill,
      }
      for (const item of issue.record.items) {
        if (!allowed.has(item.section)) continue
        row.included++
        if (published.has(item.id)) {
          row.alreadyPublished++
          continue
        }
        if (seen.has(item.id)) {
          row.duplicate++
          continue
        }
        seen.add(item.id)
        candidates.push(item)
        row.kept++
      }
      explain.rows.push(row)
      if (row.kept > 0) {
        contributed.set(`${issue.date}|${issue.slot ?? ''}`, { date: issue.date, slot: issue.slot })
        // The newest issue that has one wins: `findIssues` walks newest-first.
        if (!digest && issue.record.digest) digest = issue.record.digest
      }
    }
  }

  absorb(findIssues(config.archive.dir, window, slots, fs, false))

  if (explain.rows.length === 0) {
    return {
      issue: null,
      reason: 'no-archive',
      detail:
        `no archived issue for ${window.join(', ')} (slots: ${slots.join(', ')}) — ` +
        `the brief has probably not run yet; catchUpDays retries tomorrow`,
      explain,
    }
  }

  // §1.3 step 6 — widen the window backwards before giving up. Anything it finds that an
  // earlier publication already carried is dropped by `published`, so backfill can only
  // add genuinely unpublished items.
  if (candidates.length < schedule.minItems && schedule.backfillDays > 0) {
    explain.backfillUsed = true
    const oldest = window[window.length - 1]!
    const older = recentDates(oldest, schedule.backfillDays + 1).slice(1)
    absorb(findIssues(config.archive.dir, older, slots, fs, true))
  }

  explain.candidates = candidates.length

  if (candidates.length < schedule.minItems) {
    return {
      issue: null,
      reason: 'too-few-items',
      detail:
        `only ${candidates.length} item(s) after the section whitelist, below minItems ` +
        `${schedule.minItems} — skipping rather than posting filler`,
      explain,
    }
  }

  const ranked = [...candidates].sort(byRank)
  const kept = ranked.slice(0, schedule.maxItems)
  explain.cappedBy = ranked.length - kept.length
  explain.kept = kept.length

  const built: BriefSection[] = sections
    .map((section) => ({
      id: section.id,
      title: section.title,
      items: kept.filter((item) => item.section === section.id).sort(byRank),
    }))
    .filter((section) => section.items.length > 0)
  explain.bySection = built.map((s) => ({ id: s.id, title: s.title, items: s.items.length }))

  // Chronological, oldest first: it is the order the footer reads in, and its last entry
  // is the issue `adapt.ts` treats as the first-publication page.
  const sources = [...contributed.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      slotRank(config, a.slot).localeCompare(slotRank(config, b.slot)),
  )
  const dates = [...new Set(sources.map((s) => s.date))].sort()
  const range =
    dates.length > 1 ? `${dates[0]} → ${dates[dates.length - 1]}` : (dates[0] ?? publishDate)

  return {
    issue: {
      scheduleId: schedule.id,
      publishDate,
      sources,
      sections: built,
      itemIds: kept.map((item) => item.id),
      ...(digest ? { digest } : {}),
      range,
    },
    explain,
  }
}

/** The `--explain` table. Its whole job is to answer "why only 9 items today". */
export function renderExplain(explain: CollectExplain): string {
  const lines = [
    `line ${explain.scheduleId} · publish ${explain.publishDate}`,
    `window: ${explain.window.join(', ')} · slots: ${explain.slots.join(', ')}`,
    `include: ${explain.include.join(', ')}`,
    '',
    '| 归档 | 全部 | 白名单内 | 已发过 | 窗口内重复 | 采用 |',
    '| ---- | ---- | -------- | ------ | ---------- | ---- |',
  ]
  for (const row of explain.rows) {
    const label = `${row.date}${row.slot ? `.${row.slot}` : ''}${row.backfill ? ' (backfill)' : ''}`
    lines.push(
      `| ${label} | ${row.total} | ${row.included} | ${row.alreadyPublished} | ` +
        `${row.duplicate} | ${row.kept} |`,
    )
  }
  lines.push('')
  lines.push(
    `候选 ${explain.candidates} 条 → 截断 ${explain.cappedBy} 条 → 最终 ${explain.kept} 条 ` +
      `(minItems ${explain.minItems}${explain.backfillUsed ? '，用了 backfill' : ''})`,
  )
  for (const section of explain.bySection) {
    lines.push(`  - ${section.title} (${section.id})：${section.items}`)
  }
  return lines.join('\n')
}
