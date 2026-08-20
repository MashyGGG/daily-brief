import type { Item, RawItem, Section, Source } from '../config/schema'

/**
 * §3.3 — v1 has no LLM, so "which 8 make the cut" is decided by a deterministic weighting.
 *
 *   rankScore = sourceWeight × (0.6 × normScore + 0.4 × recency)
 *     normScore = the item's percentile within its own source (HN points / GitHub stars);
 *                 a source with no scores at all (RSS) sits at the 0.5 median
 *     recency   = 1 − (now − publishedAt) / lookbackHours, clamped to [0, 1]
 *
 * Everything here is a pure function of its inputs, so two runs over the same input
 * produce identical scores and identical winners (A10).
 */

export const SCORE_WEIGHT = 0.6
export const RECENCY_WEIGHT = 0.4
export const NO_SCORE_PERCENTILE = 0.5

/** Rounded so an archived rankScore compares exactly across runs and platforms. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.min(1, Math.max(0, n))
}

export function recencyOf(publishedAt: string, now: Date, lookbackHours: number): number {
  const t = new Date(publishedAt).getTime()
  if (Number.isNaN(t) || lookbackHours <= 0) return 0
  const ageHours = (now.getTime() - t) / 3600_000
  return clamp01(1 - ageHours / lookbackHours)
}

/**
 * Mid-rank percentile: (strictly-lower + half-of-ties) / n.
 * A lone item, or a fully tied set, lands on 0.5 — the same place a scoreless source sits.
 */
export function percentileRank(score: number, scores: number[]): number {
  if (scores.length === 0) return NO_SCORE_PERCENTILE
  let lower = 0
  let equal = 0
  for (const s of scores) {
    if (s < score) lower++
    else if (s === score) equal++
  }
  return clamp01((lower + equal / 2) / scores.length)
}

export interface RankOptions {
  now: Date
  lookbackHours: number
  /** source name → weight, from the config. Unknown sources default to 1. */
  weights: Record<string, number>
}

export function weightsOf(sources: Source[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of sources) out[s.name] = s.weight
  return out
}

/** Attach a rankScore + section id to every item. Percentiles are computed per source. */
export function rank(items: RawItem[], section: string, options: RankOptions): Item[] {
  const scoresBySource = new Map<string, number[]>()
  for (const item of items) {
    if (typeof item.score !== 'number') continue
    const list = scoresBySource.get(item.source) ?? []
    list.push(item.score)
    scoresBySource.set(item.source, list)
  }

  return items.map((item) => {
    const scores = scoresBySource.get(item.source) ?? []
    const normScore =
      typeof item.score === 'number' && scores.length > 0
        ? percentileRank(item.score, scores)
        : NO_SCORE_PERCENTILE
    const recency = recencyOf(item.publishedAt, options.now, options.lookbackHours)
    const weight = options.weights[item.source] ?? 1
    return {
      ...item,
      section,
      rankScore: round6(weight * (SCORE_WEIGHT * normScore + RECENCY_WEIGHT * recency)),
    }
  })
}

/** Total order: rankScore desc, then newest, then id — never dependent on input order. */
export function compareItems(a: Item, b: Item): number {
  if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore
  const at = new Date(a.publishedAt).getTime()
  const bt = new Date(b.publishedAt).getTime()
  if (bt !== at) return bt - at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Pick the section's final line-up.
 *
 * `minPerSource` reserves a slot for every source that has anything to offer, so a single
 * high-volume source (HN) cannot eat the whole section. When the reservations cannot all
 * fit, **`limit` wins**: sources are served in descending order of their best item, and the
 * ones that do not fit are dropped.
 */
export function selectForSection(items: Item[], section: Section): Item[] {
  const sorted = [...items].sort(compareItems)
  const limit = section.limit
  if (sorted.length <= 0 || limit <= 0) return []

  const chosen: Item[] = []
  const taken = new Set<string>()

  if (section.minPerSource > 0) {
    const bySource = new Map<string, Item[]>()
    for (const item of sorted) {
      const list = bySource.get(item.source) ?? []
      list.push(item)
      bySource.set(item.source, list)
    }
    // Serve sources in order of their strongest item so a truncated quota drops the weakest.
    const sourceOrder = [...bySource.keys()].sort((a, b) => {
      const ia = bySource.get(a)![0]!
      const ib = bySource.get(b)![0]!
      return compareItems(ia, ib)
    })
    for (let round = 0; round < section.minPerSource; round++) {
      for (const source of sourceOrder) {
        if (chosen.length >= limit) break
        const candidate = bySource.get(source)![round]
        if (!candidate || taken.has(candidate.id)) continue
        taken.add(candidate.id)
        chosen.push(candidate)
      }
      if (chosen.length >= limit) break
    }
  }

  for (const item of sorted) {
    if (chosen.length >= limit) break
    if (taken.has(item.id)) continue
    taken.add(item.id)
    chosen.push(item)
  }

  return chosen.sort(compareItems)
}
