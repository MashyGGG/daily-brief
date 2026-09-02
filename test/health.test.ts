import { describe, expect, it } from 'vitest'
import type { Source } from '../src/config/schema'
import {
  describeStale,
  describeUndated,
  findStaleSources,
  findUndatedSources,
  healthWarnings,
  staleAfterDaysOf,
} from '../src/core/health'
import { latestPublishedAt, type SourceOutcome } from '../src/sources'
import { NOW, rawItem } from './helpers'

function rssSource(name: string, staleAfterDays?: number): Source {
  return {
    name,
    type: 'rss',
    weight: 1,
    stripPatterns: [],
    ...(staleAfterDays !== undefined ? { staleAfterDays } : {}),
    params: { url: `https://example.com/${name}.xml`, limit: 50 },
  }
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString()
}

function outcome(source: string, ages: number[], error?: string): SourceOutcome {
  const items = ages.map((d) => rawItem({ source, publishedAt: daysAgo(d) }))
  return {
    source,
    items: error ? [] : items,
    latestPublishedAt: error ? undefined : latestPublishedAt(items),
    ...(error ? { error } : {}),
    durationMs: 12,
  }
}

describe('latestPublishedAt', () => {
  it('picks the newest, regardless of input order', () => {
    const items = [daysAgo(9), daysAgo(1), daysAgo(40)].map((publishedAt) =>
      rawItem({ publishedAt }),
    )
    expect(latestPublishedAt(items)).toBe(daysAgo(1))
  })

  it('is undefined for an empty batch', () => {
    expect(latestPublishedAt([])).toBeUndefined()
  })
})

describe('staleAfterDaysOf', () => {
  it('falls back to the 30-day default', () => {
    expect(staleAfterDaysOf(rssSource('a'))).toBe(30)
  })

  it('honours a per-source budget', () => {
    expect(staleAfterDaysOf(rssSource('typescript-releases', 240))).toBe(240)
  })
})

describe('findStaleSources', () => {
  const sources = [rssSource('fresh'), rssSource('slow', 180), rssSource('dead')]

  it('says nothing about a source inside its budget', () => {
    const found = findStaleSources([outcome('fresh', [0.2, 3])], sources, NOW)
    expect(found).toEqual([])
  })

  /** The whole point: HTTP 200, a well-formed feed, and content from last spring. */
  it('flags a 200 that has not published in months', () => {
    const found = findStaleSources([outcome('dead', [1200])], sources, NOW)
    expect(found).toEqual([{ source: 'dead', ageDays: expect.closeTo(1200, 3), thresholdDays: 30 }])
  })

  it('does not flag a slow source that declared a wider budget', () => {
    expect(findStaleSources([outcome('slow', [83])], sources, NOW)).toEqual([])
    expect(findStaleSources([outcome('slow', [200])], sources, NOW)).toHaveLength(1)
  })

  it('treats an empty-but-successful fetch as unhealthy', () => {
    const found = findStaleSources([{ source: 'fresh', items: [], durationMs: 5 }], sources, NOW)
    expect(found).toEqual([{ source: 'fresh', ageDays: null, thresholdDays: 30 }])
  })

  /** A failed source already carries its own warning; two lines for one fault is noise. */
  it('stays quiet about a source that failed outright', () => {
    const found = findStaleSources([outcome('dead', [], 'HTTP 503')], sources, NOW)
    expect(found).toEqual([])
  })

  it('uses the default budget for a source missing from the config', () => {
    const found = findStaleSources([outcome('unknown', [45])], sources, NOW)
    expect(found[0]).toMatchObject({ source: 'unknown', thresholdDays: 30 })
  })

  it('is exclusive at the boundary — exactly at budget is not yet stale', () => {
    expect(findStaleSources([outcome('fresh', [30])], sources, NOW)).toEqual([])
    expect(findStaleSources([outcome('fresh', [30.1])], sources, NOW)).toHaveLength(1)
  })
})

describe('describeStale', () => {
  it('names the age and the budget', () => {
    expect(describeStale({ source: 'web-dev', ageDays: 83.4, thresholdDays: 30 })).toBe(
      'source "web-dev" looks stale: newest item is 83 days old (budget 30d)',
    )
  })

  it('says something different when nothing came back at all', () => {
    expect(describeStale({ source: 'juejin', ageDays: null, thresholdDays: 30 })).toContain(
      'returned 0 items',
    )
  })
})

/** `normalize()` stamps an undated entry with the run clock, to the millisecond. */
function undatedOutcome(source: string, count: number): SourceOutcome {
  const items = Array.from({ length: count }, () =>
    rawItem({ source, publishedAt: NOW.toISOString() }),
  )
  return { source, items, latestPublishedAt: latestPublishedAt(items), durationMs: 8 }
}

describe('findUndatedSources', () => {
  it('flags a feed whose every item carries the run clock', () => {
    expect(findUndatedSources([undatedOutcome('meituan-tech', 10)], NOW)).toEqual(['meituan-tech'])
  })

  /** One real date is enough: the feed dates its entries, this batch is just fresh. */
  it('stays quiet when a single item has a date of its own', () => {
    const undated = undatedOutcome('mixed', 3)
    undated.items[1]!.publishedAt = daysAgo(2)
    expect(findUndatedSources([undated], NOW)).toEqual([])
  })

  it('stays quiet about a normal feed, however fresh', () => {
    expect(findUndatedSources([outcome('fresh', [0.01, 0.5])], NOW)).toEqual([])
  })

  /** Both already carry their own warning; a second line for one fault is noise. */
  it('ignores empty and failed batches', () => {
    expect(findUndatedSources([{ source: 'empty', items: [], durationMs: 3 }], NOW)).toEqual([])
    expect(findUndatedSources([outcome('dead', [], 'HTTP 503')], NOW)).toEqual([])
  })
})

describe('describeUndated', () => {
  it('says the check is blind rather than that the source is stale', () => {
    const line = describeUndated('meituan-tech')
    expect(line).toContain('ships no per-item dates')
    expect(line).not.toContain('looks stale')
  })
})

describe('healthWarnings', () => {
  it('returns one line per unhealthy source and nothing for a clean run', () => {
    const sources = [rssSource('a'), rssSource('b')]
    expect(healthWarnings([outcome('a', [1]), outcome('b', [2])], sources, NOW)).toEqual([])
    expect(healthWarnings([outcome('a', [1]), outcome('b', [400])], sources, NOW)).toHaveLength(1)
  })

  it('reports staleness and datelessness as separate lines', () => {
    const sources = [rssSource('a'), rssSource('b')]
    const lines = healthWarnings([outcome('a', [400]), undatedOutcome('b', 4)], sources, NOW)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('looks stale')
    expect(lines[1]).toContain('ships no per-item dates')
  })
})
