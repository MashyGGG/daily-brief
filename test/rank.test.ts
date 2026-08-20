import { describe, expect, it } from 'vitest'
import {
  NO_SCORE_PERCENTILE,
  compareItems,
  percentileRank,
  rank,
  recencyOf,
  selectForSection,
} from '../src/core/rank'
import type { Section } from '../src/config/schema'
import { NOW, item, rawItem } from './helpers'

const section = (over: Partial<Section> = {}): Section => ({
  id: 'tech',
  title: '国际技术',
  sources: ['a', 'b'],
  limit: 4,
  minPerSource: 0,
  include: [],
  exclude: [],
  ...over,
})

const opts = { now: NOW, lookbackHours: 24, weights: { a: 1, b: 1 } }

describe('percentileRank', () => {
  it('puts a lone item at the median', () => {
    expect(percentileRank(500, [500])).toBe(NO_SCORE_PERCENTILE)
  })

  it('puts a fully tied set at the median', () => {
    expect(percentileRank(10, [10, 10, 10, 10])).toBe(0.5)
  })

  it('orders a distinct set monotonically', () => {
    const scores = [1, 2, 3, 4]
    const ranks = scores.map((s) => percentileRank(s, scores))
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y))
    expect(ranks[0]!).toBeLessThan(ranks[3]!)
  })

  it('gives tied items the same percentile', () => {
    const scores = [1, 5, 5, 9]
    expect(percentileRank(5, scores)).toBe(percentileRank(5, scores))
  })

  it('falls back to the median with no scores at all', () => {
    expect(percentileRank(3, [])).toBe(NO_SCORE_PERCENTILE)
  })
})

describe('recency', () => {
  it('is 1 for something published right now', () => {
    expect(recencyOf(NOW.toISOString(), NOW, 24)).toBe(1)
  })

  it('is 0 at the far end of the window', () => {
    const at = new Date(NOW.getTime() - 24 * 3600_000).toISOString()
    expect(recencyOf(at, NOW, 24)).toBe(0)
  })

  it('clamps rather than going negative past the window', () => {
    const at = new Date(NOW.getTime() - 100 * 3600_000).toISOString()
    expect(recencyOf(at, NOW, 24)).toBe(0)
  })

  it('clamps rather than exceeding 1 for a future date', () => {
    const at = new Date(NOW.getTime() + 3600_000).toISOString()
    expect(recencyOf(at, NOW, 24)).toBe(1)
  })

  it('is 0.5 at the halfway point', () => {
    const at = new Date(NOW.getTime() - 12 * 3600_000).toISOString()
    expect(recencyOf(at, NOW, 24)).toBe(0.5)
  })
})

describe('rank', () => {
  it('A10 — is reproducible: identical input gives identical scores', () => {
    const items = [
      rawItem({ id: '1', source: 'a', score: 100, publishedAt: NOW.toISOString() }),
      rawItem({ id: '2', source: 'a', score: 200, publishedAt: NOW.toISOString() }),
    ]
    expect(rank(items, 'tech', opts)).toEqual(rank(items, 'tech', opts))
  })

  it('scores a scoreless source at the median rather than at zero', () => {
    const scoreless = rank([rawItem({ id: '1', source: 'a' })], 'tech', opts)[0]!
    // 1 × (0.6 × 0.5 + 0.4 × 1) = 0.7
    expect(scoreless.rankScore).toBeCloseTo(0.7, 6)
  })

  it('applies the source weight multiplicatively', () => {
    const weighted = rank([rawItem({ id: '1', source: 'a' })], 'tech', {
      ...opts,
      weights: { a: 2 },
    })[0]!
    expect(weighted.rankScore).toBeCloseTo(1.4, 6)
  })

  it('computes percentiles per source, not globally', () => {
    const items = [
      rawItem({ id: '1', source: 'a', score: 10 }),
      rawItem({ id: '2', source: 'b', score: 10_000 }),
    ]
    const ranked = rank(items, 'tech', opts)
    // Each is the only scored item in its own source, so both sit at the median.
    expect(ranked[0]!.rankScore).toBe(ranked[1]!.rankScore)
  })

  it('stamps the section id onto every item', () => {
    expect(rank([rawItem({ id: '1' })], 'news', opts)[0]!.section).toBe('news')
  })
})

describe('compareItems', () => {
  it('breaks a rankScore tie by recency, then by id — never by input order', () => {
    const older = item({ id: 'zzz', rankScore: 0.5, publishedAt: '2026-08-19T00:00:00.000Z' })
    const newer = item({ id: 'aaa', rankScore: 0.5, publishedAt: '2026-08-20T00:00:00.000Z' })
    expect([older, newer].sort(compareItems)[0]!.id).toBe('aaa')
    expect([newer, older].sort(compareItems)[0]!.id).toBe('aaa')
  })

  it('is a stable total order for fully tied items', () => {
    const x = item({ id: 'b', rankScore: 0.5, publishedAt: NOW.toISOString() })
    const y = item({ id: 'a', rankScore: 0.5, publishedAt: NOW.toISOString() })
    expect([x, y].sort(compareItems).map((i) => i.id)).toEqual(['a', 'b'])
    expect([y, x].sort(compareItems).map((i) => i.id)).toEqual(['a', 'b'])
  })
})

describe('selectForSection', () => {
  const mk = (id: string, source: string, rankScore: number) =>
    item({ id, source, rankScore, publishedAt: NOW.toISOString() })

  it('takes the top `limit` by rankScore', () => {
    const items = [mk('1', 'a', 0.9), mk('2', 'a', 0.8), mk('3', 'a', 0.7)]
    expect(selectForSection(items, section({ limit: 2 })).map((i) => i.id)).toEqual(['1', '2'])
  })

  it('minPerSource reserves a slot so one source cannot take everything', () => {
    const items = [
      mk('a1', 'a', 0.99),
      mk('a2', 'a', 0.98),
      mk('a3', 'a', 0.97),
      mk('b1', 'b', 0.1),
    ]
    const chosen = selectForSection(items, section({ limit: 3, minPerSource: 1 }))
    expect(chosen.map((i) => i.source)).toContain('b')
    expect(chosen).toHaveLength(3)
  })

  it('without minPerSource, one source may take the whole section', () => {
    const items = [mk('a1', 'a', 0.99), mk('a2', 'a', 0.98), mk('b1', 'b', 0.1)]
    const chosen = selectForSection(items, section({ limit: 2, minPerSource: 0 }))
    expect(chosen.map((i) => i.source)).toEqual(['a', 'a'])
  })

  it('A10 — limit wins when the minPerSource reservations cannot all fit', () => {
    const items = [mk('a1', 'a', 0.9), mk('b1', 'b', 0.5), mk('c1', 'c', 0.1)]
    const chosen = selectForSection(items, section({ limit: 2, minPerSource: 1 }))
    expect(chosen).toHaveLength(2)
    // The weakest source is the one dropped.
    expect(chosen.map((i) => i.id)).toEqual(['a1', 'b1'])
  })

  it('returns the result sorted by rankScore regardless of quota order', () => {
    const items = [mk('a1', 'a', 0.9), mk('b1', 'b', 0.2), mk('a2', 'a', 0.5)]
    const chosen = selectForSection(items, section({ limit: 3, minPerSource: 1 }))
    expect(chosen.map((i) => i.rankScore)).toEqual([0.9, 0.5, 0.2])
  })

  it('handles an empty section', () => {
    expect(selectForSection([], section())).toEqual([])
  })

  it('never returns the same item twice', () => {
    const items = [mk('a1', 'a', 0.9), mk('a2', 'a', 0.8)]
    const chosen = selectForSection(items, section({ limit: 5, minPerSource: 2 }))
    expect(new Set(chosen.map((i) => i.id)).size).toBe(chosen.length)
  })
})
