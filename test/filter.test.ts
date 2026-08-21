import { describe, expect, it } from 'vitest'
import {
  filterForSection,
  matchesKeyword,
  minScoreBySource,
  withinWindow,
} from '../src/core/filter'
import type { Section, Source } from '../src/config/schema'
import { NOW, rawItem } from './helpers'

const section = (over: Partial<Section> = {}): Section => ({
  id: 'tech',
  title: '国际技术',
  sources: ['hn-front'],
  limit: 8,
  minPerSource: 0,
  include: [],
  exclude: [],
  enabled: true,
  ...over,
})

describe('keyword matching', () => {
  it('is case-insensitive for ASCII', () => {
    expect(matchesKeyword(rawItem({ title: 'A CRYPTO winter' }), 'crypto')).toBe(true)
    expect(matchesKeyword(rawItem({ title: 'a crypto winter' }), 'CRYPTO')).toBe(true)
  })

  it('matches Chinese keywords literally', () => {
    expect(matchesKeyword(rawItem({ title: '国际要闻速览' }), '要闻')).toBe(true)
    expect(matchesKeyword(rawItem({ title: '国际要闻速览' }), '技术')).toBe(false)
  })

  it('also searches the excerpt', () => {
    expect(matchesKeyword(rawItem({ title: 'Plain', excerpt: 'about NFT markets' }), 'nft')).toBe(
      true,
    )
  })
})

describe('time window', () => {
  const opts = { now: NOW, lookbackHours: 24 }

  it('keeps an item exactly on the trailing edge', () => {
    const at = new Date(NOW.getTime() - 24 * 3600_000).toISOString()
    expect(withinWindow(rawItem({ publishedAt: at }), opts)).toBe(true)
  })

  it('drops an item one millisecond past the edge', () => {
    const at = new Date(NOW.getTime() - 24 * 3600_000 - 1).toISOString()
    expect(withinWindow(rawItem({ publishedAt: at }), opts)).toBe(false)
  })

  it('keeps an item published exactly now', () => {
    expect(withinWindow(rawItem({ publishedAt: NOW.toISOString() }), opts)).toBe(true)
  })

  it('drops an item dated in the future', () => {
    const at = new Date(NOW.getTime() + 60_000).toISOString()
    expect(withinWindow(rawItem({ publishedAt: at }), opts)).toBe(false)
  })

  it('drops an unparseable date rather than guessing', () => {
    expect(withinWindow(rawItem({ publishedAt: 'never' }), opts)).toBe(false)
  })
})

describe('filterForSection', () => {
  const base = { now: NOW, lookbackHours: 24 }

  it('keeps only the sources this section subscribes to', () => {
    const items = [rawItem({ source: 'hn-front' }), rawItem({ source: 'verge' })]
    expect(filterForSection(items, section(), base).map((i) => i.source)).toEqual(['hn-front'])
  })

  it('exclude wins over include', () => {
    const items = [rawItem({ title: 'AI crypto exchange' })]
    const result = filterForSection(items, section({ include: ['ai'], exclude: ['crypto'] }), base)
    expect(result).toHaveLength(0)
  })

  it('an empty include list filters nothing', () => {
    const items = [rawItem({ title: 'Anything' })]
    expect(filterForSection(items, section(), base)).toHaveLength(1)
  })

  it('a non-empty include list drops everything that does not match', () => {
    const items = [rawItem({ title: 'About Rust' }), rawItem({ title: 'About cooking' })]
    const result = filterForSection(items, section({ include: ['rust'] }), base)
    expect(result.map((i) => i.title)).toEqual(['About Rust'])
  })

  describe('minPoints boundary', () => {
    const opts = { ...base, minScoreBySource: { 'hn-front': 100 } }

    it('drops an item one point below the floor', () => {
      expect(filterForSection([rawItem({ score: 99 })], section(), opts)).toHaveLength(0)
    })

    it('keeps an item exactly at the floor', () => {
      expect(filterForSection([rawItem({ score: 100 })], section(), opts)).toHaveLength(1)
    })

    it('drops a scoreless item when the source declares a floor', () => {
      expect(filterForSection([rawItem({})], section(), opts)).toHaveLength(0)
    })

    it('keeps a scoreless item when the source declares no floor', () => {
      expect(filterForSection([rawItem({})], section(), base)).toHaveLength(1)
    })
  })
})

describe('minScoreBySource', () => {
  it('reads minPoints / minStars off the source definitions', () => {
    const sources: Source[] = [
      {
        name: 'hn-front',
        type: 'hackernews',
        weight: 1,
        stripPatterns: [],
        params: { mode: 'front_page', minPoints: 100, limit: 50 },
      },
      {
        name: 'gh',
        type: 'github',
        weight: 1,
        stripPatterns: [],
        params: { createdWithinDays: 7, minStars: 50, limit: 30 },
      },
      {
        name: 'verge',
        type: 'rss',
        weight: 1,
        stripPatterns: [],
        params: { url: 'https://a.com/rss', limit: 50 },
      },
    ]
    expect(minScoreBySource(sources)).toEqual({ 'hn-front': 100, gh: 50 })
  })
})
