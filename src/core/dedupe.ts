import type { Item, RawItem } from '../config/schema'
import { normalizeTitle } from './normalize'

export interface SeenSet {
  ids: Set<string>
  titles: Set<string>
}

export function emptySeen(): SeenSet {
  return { ids: new Set(), titles: new Set() }
}

/**
 * §3.5 — the archive *is* the state. Cross-day dedupe reads the last N days of archived
 * items instead of keeping a second state file.
 */
export function seenFromArchive(archived: Iterable<Pick<Item, 'id' | 'title'>>): SeenSet {
  const seen = emptySeen()
  for (const item of archived) {
    seen.ids.add(item.id)
    seen.titles.add(normalizeTitle(item.title))
  }
  return seen
}

export interface DedupeResult<T extends RawItem> {
  items: T[]
  /** How many were dropped, split by cause — surfaced in the run summary. */
  droppedWithinRun: number
  droppedAsSeen: number
}

/**
 * Drop duplicates inside this run (URL first, then near-identical title) and anything
 * already published on a previous day.
 *
 * Input order is preserved and the FIRST occurrence wins, so callers control which
 * duplicate survives by ordering (higher-weight sources first).
 */
export function dedupe<T extends RawItem>(
  items: T[],
  seen: SeenSet = emptySeen(),
): DedupeResult<T> {
  const localIds = new Set<string>()
  const localTitles = new Set<string>()
  const out: T[] = []
  let droppedWithinRun = 0
  let droppedAsSeen = 0

  for (const item of items) {
    const titleKey = normalizeTitle(item.title)
    if (seen.ids.has(item.id) || (titleKey !== '' && seen.titles.has(titleKey))) {
      droppedAsSeen++
      continue
    }
    if (localIds.has(item.id) || (titleKey !== '' && localTitles.has(titleKey))) {
      droppedWithinRun++
      continue
    }
    localIds.add(item.id)
    if (titleKey !== '') localTitles.add(titleKey)
    out.push(item)
  }

  return { items: out, droppedWithinRun, droppedAsSeen }
}
