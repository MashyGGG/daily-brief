import type { Item, RawItem } from '../config/schema'
import { normalizeTitle } from './normalize'

/**
 * Character n-gram width for the near-duplicate check. Measured over the 08-20 / 08-21
 * archives (43 titles): at n=4 the one genuine cross-post of a story scored 0.286 while the
 * worst unrelated pair scored 0.086; n=3 narrows that gap to 0.306 vs 0.153, and n=2
 * inverts it (0.341 vs 0.444) — there, the check would drop real stories and keep the dupe.
 */
const TITLE_GRAM = 4

/**
 * Fewer grams than this and a title is too short to score honestly — `v4.1.1` normalizes to
 * a single gram, which would either match nothing or everything. Those keep exact matching
 * only, which is what already separates two release tags from the same repo.
 */
const MIN_GRAMS = 8

/** Unique character n-grams of a normalized title, whitespace removed. */
export function titleGrams(title: string): Set<string> {
  const chars = [...normalizeTitle(title).replace(/\s+/gu, '')]
  const grams = new Set<string>()
  for (let i = 0; i + TITLE_GRAM <= chars.length; i++) {
    grams.add(chars.slice(i, i + TITLE_GRAM).join(''))
  }
  return grams
}

/**
 * Digits are how a headline says "a different one of these": `Announcing Rust 1.98.0` against
 * `Announcing Rust 1.99.0` shares 7 of its 8 grams and scores 0.875, and so does `story 1`
 * against `story 2`. So two titles whose numbers disagree are two stories no matter how alike
 * the prose reads, and the similarity check declines to judge them.
 *
 * The rule is deliberately one-sided. A genuine cross-post where one outlet put `620%` in the
 * headline and the other did not will survive as a duplicate — that costs one seat, once.
 * Getting it wrong the other way deletes a real story and leaves no trace that it existed.
 */
export function titleNumbers(title: string): string {
  return (title.match(/\d+/gu) ?? []).sort().join(',')
}

/**
 * Inverted gram → title index behind the near-duplicate check.
 *
 * Scoring each incoming title against every title kept so far is O(n·m) set intersections,
 * and a full run carries a few thousand fetched items against a fortnight of archive. The
 * postings list produces the very same intersection sizes in one pass over the incoming
 * title's own grams, so the check stays exact and stops being quadratic.
 */
export class TitleIndex {
  private readonly sizes: number[] = []
  private readonly numbers: string[] = []
  private readonly postings = new Map<string, number[]>()

  add(grams: Set<string>, numbers: string): void {
    if (grams.size < MIN_GRAMS) return
    const id = this.sizes.push(grams.size) - 1
    this.numbers.push(numbers)
    for (const gram of grams) {
      const list = this.postings.get(gram)
      if (list) list.push(id)
      else this.postings.set(gram, [id])
    }
  }

  /**
   * The highest Dice coefficient between `grams` and anything indexed carrying the same
   * numbers; 0 when nothing qualifies.
   */
  best(grams: Set<string>, numbers: string): number {
    if (grams.size < MIN_GRAMS) return 0
    const shared = new Map<number, number>()
    for (const gram of grams) {
      for (const id of this.postings.get(gram) ?? []) shared.set(id, (shared.get(id) ?? 0) + 1)
    }
    let best = 0
    for (const [id, hits] of shared) {
      if (this.numbers[id] !== numbers) continue
      const score = (2 * hits) / (grams.size + this.sizes[id]!)
      if (score > best) best = score
    }
    return best
  }
}

export interface SeenSet {
  ids: Set<string>
  titles: Set<string>
  /** Near-duplicate index over those same titles (§`dedupeSchema`). */
  index: TitleIndex
}

export function emptySeen(): SeenSet {
  return { ids: new Set(), titles: new Set(), index: new TitleIndex() }
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
    seen.index.add(titleGrams(item.title), titleNumbers(item.title))
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
 * Drop duplicates inside this run (URL first, then identical title, then near-identical
 * title) and anything already published on a previous day.
 *
 * `titleSimilarity` is the Dice threshold for that last check; `0` disables it and leaves
 * the exact-match behaviour untouched. It is a parameter rather than a module constant so
 * the pure function stays callable from a test without a config.
 *
 * Input order is preserved and the FIRST occurrence wins, so callers control which
 * duplicate survives by ordering (higher-weight sources first).
 */
export function dedupe<T extends RawItem>(
  items: T[],
  seen: SeenSet = emptySeen(),
  titleSimilarity = 0,
): DedupeResult<T> {
  const localIds = new Set<string>()
  const localTitles = new Set<string>()
  const localIndex = new TitleIndex()
  const nearDupes = titleSimilarity > 0
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

    // Only worth building grams once the cheap exact checks have passed.
    const grams = nearDupes ? titleGrams(item.title) : null
    if (grams) {
      const numbers = titleNumbers(item.title)
      if (seen.index.best(grams, numbers) >= titleSimilarity) {
        droppedAsSeen++
        continue
      }
      if (localIndex.best(grams, numbers) >= titleSimilarity) {
        droppedWithinRun++
        continue
      }
      localIndex.add(grams, numbers)
    }

    localIds.add(item.id)
    if (titleKey !== '') localTitles.add(titleKey)
    out.push(item)
  }

  return { items: out, droppedWithinRun, droppedAsSeen }
}
