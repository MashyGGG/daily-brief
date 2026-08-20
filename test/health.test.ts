import { describe, expect, it } from 'vitest'
import type { Source } from '../src/config/schema'
import {
  describeStale,
  findStaleSources,
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

describe('healthWarnings', () => {
  it('returns one line per unhealthy source and nothing for a clean run', () => {
    const sources = [rssSource('a'), rssSource('b')]
    expect(healthWarnings([outcome('a', [1]), outcome('b', [2])], sources, NOW)).toEqual([])
    expect(healthWarnings([outcome('a', [1]), outcome('b', [400])], sources, NOW)).toHaveLength(1)
  })
})
