import type { RawItem, Section, Source } from '../config/schema'

/**
 * Keyword matching is case-insensitive for ASCII and literal for CJK (which has no case).
 * Matching runs over title + excerpt so a keyword in the summary still counts.
 */
export function matchesKeyword(item: RawItem, keyword: string): boolean {
  const haystack = `${item.title}\n${item.excerpt ?? ''}`.toLowerCase()
  return haystack.includes(keyword.toLowerCase())
}

export interface WindowOptions {
  now: Date
  lookbackHours: number
}

/** Inclusive on both ends: an item published exactly at the window edge is kept. */
export function withinWindow(item: RawItem, { now, lookbackHours }: WindowOptions): boolean {
  const published = new Date(item.publishedAt).getTime()
  if (Number.isNaN(published)) return false
  const cutoff = now.getTime() - lookbackHours * 3600_000
  return published >= cutoff && published <= now.getTime()
}

export interface FilterOptions extends WindowOptions {
  /** Per-source minimum score, keyed by source name (from `params.minPoints` / `minStars`). */
  minScoreBySource?: Record<string, number>
}

/** Apply a section's include/exclude keywords, the time window, and per-source score floors. */
export function filterForSection(
  items: RawItem[],
  section: Section,
  options: FilterOptions,
): RawItem[] {
  const allowedSources = new Set(section.sources)
  const minScore = options.minScoreBySource ?? {}

  return items.filter((item) => {
    if (!allowedSources.has(item.source)) return false
    if (!withinWindow(item, options)) return false

    const floor = minScore[item.source]
    if (typeof floor === 'number' && floor > 0) {
      if (typeof item.score !== 'number' || item.score < floor) return false
    }

    if (section.exclude.length > 0 && section.exclude.some((k) => matchesKeyword(item, k))) {
      return false
    }
    if (section.include.length > 0 && !section.include.some((k) => matchesKeyword(item, k))) {
      return false
    }
    return true
  })
}

/** Score floors declared on the sources themselves, collected once per run. */
export function minScoreBySource(sources: Source[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const source of sources) {
    if (source.type === 'hackernews') out[source.name] = source.params.minPoints
    else if (source.type === 'github') out[source.name] = source.params.minStars
  }
  return out
}
