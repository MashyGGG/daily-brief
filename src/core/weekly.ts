import type { BriefConfig, Item, Schedule } from '../config/schema'
import { resolveSections } from '../config/schema'
import { nodeFs, type FsLike } from '../archive/fs'
import {
  archiveNames,
  isReprint,
  parseArchiveFilename,
  recentDates,
  WEEKLY_SLOT,
} from '../archive/paths'
import { parseArchiveRecord } from '../archive/read'
import type { BriefSection } from './brief'

/**
 * §9 M3 — the weekly review.
 *
 * It fetches nothing and re-summarizes nothing. Every item in the daily archives already
 * carries the summary the morning run paid for (§1.2 is what makes that true: the archive
 * keeps `summary` next to `excerpt`), so a week's worth of reading costs one read of the
 * files this repo already committed. Decision 10's reasoning applies here too — the
 * archive IS the cache, and adding a second store of the same text would be the new
 * state that section refuses.
 *
 * The re-ranking is deliberately the same number the daily run computed (`rankScore`) and
 * not a fresh one: the week's best item is the best item of the day it appeared, and
 * re-scoring it now — against a `now` a week later — would only measure how old it is.
 *
 * The issue it produces IS archived, under the `weekly` slot — it is what was sent, and
 * §3.5's rule is that the archive holds what was sent. Its 导读 is the one thing in it
 * that exists nowhere else. The cost of that copy is paid here: every reader that asks
 * "what was published on day X" has to skip the reprint (`isReprint`).
 */

/**
 * The synthetic schedule id, and the archive slot — the same string on purpose: one run,
 * one name. Renderers key the 导读 label off it, so it is not a literal.
 */
export const WEEKLY_SCHEDULE_ID = WEEKLY_SLOT

export interface WeeklyWindow {
  /** Oldest date read, inclusive. */
  from: string
  /** Newest date read, inclusive — the day the weekly runs. */
  to: string
  /** Archived issues actually found in the window; a missing day is simply absent. */
  issues: number
  /** Items collected before the per-section cap. */
  collected: number
}

export interface WeeklyResult {
  sections: BriefSection[]
  window: WeeklyWindow
}

/**
 * The weekly is not a `schedules[]` entry (see `weeklySchema`), but everything downstream
 * of section/recipient resolution wants a Schedule. This is that shape, derived — not a
 * second place to configure the same thing.
 */
export function weeklySchedule(config: BriefConfig): Schedule {
  return {
    id: WEEKLY_SCHEDULE_ID,
    time: config.weekly.time,
    lookbackHours: config.weekly.days * 24,
    sections: config.weekly.sections,
    recipients: config.weekly.recipients,
    enabled: config.weekly.enabled,
  }
}

/**
 * Read the window's archived issues and re-rank them into sections.
 *
 * Items are deduped by id across days: `--from-archive` re-sends and manual re-runs can
 * put the same item in two files, and the same story twice is exactly what a review is
 * supposed to fix.
 *
 * Last week's own review is skipped. It is filed under the Monday it was sent but holds
 * items from the seven days before that, so reading it would drag items out of the window
 * back in — and a review that keeps re-promoting its own picks never moves on.
 */
export function collectWeekly(
  config: BriefConfig,
  endDate: string,
  sectionIds: string[],
  fs: FsLike = nodeFs,
): WeeklyResult {
  const sections = resolveSections(sectionIds, config.sections).filter((s) => s.enabled)
  const byId = new Map(sections.map((s) => [s.id, [] as Item[]]))
  const seen = new Set<string>()
  let issues = 0
  let collected = 0

  const dates = recentDates(endDate, config.weekly.days)
  for (const date of dates) {
    const { dir } = archiveNames(config.archive.dir, date, null)
    for (const name of fs.readdir(dir)) {
      const parsed = parseArchiveFilename(name)
      if (!parsed || parsed.date !== date || isReprint(parsed.slot)) continue
      const record = parseArchiveRecord(fs.readFile(`${dir}/${name}`) ?? '')
      if (!record) continue
      issues++
      for (const item of record.items) {
        if (seen.has(item.id)) continue
        const bucket = byId.get(item.section)
        if (!bucket) continue
        seen.add(item.id)
        bucket.push(item)
        collected++
      }
    }
  }

  const built = sections
    .map((section) => ({
      id: section.id,
      title: section.title,
      items: [...byId.get(section.id)!]
        // Ties broken by date so a week of equal-scoring items still reads newest-first
        // instead of in whatever order the directory listing happened to produce.
        .sort((a, b) => b.rankScore - a.rankScore || b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, config.weekly.limitPerSection),
    }))
    .filter((s) => s.items.length > 0)

  return {
    sections: built,
    window: { from: dates[dates.length - 1]!, to: endDate, issues, collected },
  }
}

/** The line the run summary and the rendered issue both use to say what was read. */
export function describeWindow(window: WeeklyWindow): string {
  return `${window.from} → ${window.to} · ${window.issues} 期归档 · 收集 ${window.collected} 条`
}
