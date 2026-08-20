import { describe, expect, it } from 'vitest'
import { canonicalizeUrl, itemId, normalizeTitle } from '../src/core/normalize'
import { dedupe, seenFromArchive } from '../src/core/dedupe'
import { rawItem } from './helpers'

describe('canonicalizeUrl', () => {
  const cases: [string, string, string][] = [
    ['strips utm params', 'https://a.com/x?utm_source=hn&utm_medium=rss', 'a.com/x'],
    ['keeps meaningful query params', 'https://a.com/x?id=7', 'a.com/x?id=7'],
    ['sorts query params', 'https://a.com/x?b=2&a=1', 'a.com/x?a=1&b=2'],
    ['drops a trailing slash', 'https://a.com/x/', 'a.com/x'],
    ['ignores the scheme', 'http://a.com/x', 'a.com/x'],
    ['lowercases the host', 'https://A.COM/x', 'a.com/x'],
    ['strips www.', 'https://www.a.com/x', 'a.com/x'],
    ['keeps path case', 'https://a.com/X', 'a.com/X'],
    ['drops the default port', 'https://a.com:443/x', 'a.com/x'],
    ['keeps a non-default port', 'https://a.com:8443/x', 'a.com:8443/x'],
    ['drops fbclid / gclid', 'https://a.com/x?gclid=1&fbclid=2', 'a.com/x'],
  ]

  it.each(cases)('%s', (_name, input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected)
  })

  it('treats the equivalent forms as one id', () => {
    expect(itemId('http://WWW.a.com/x/?utm_source=q')).toBe(itemId('https://a.com/x'))
  })

  it('does not blow up on a non-URL', () => {
    expect(canonicalizeUrl('not a url/')).toBe('not a url')
  })
})

describe('normalizeTitle', () => {
  it('ignores case, punctuation and whitespace', () => {
    expect(normalizeTitle('Rust 1.90:  Released!')).toBe(normalizeTitle('rust 1 90 released'))
  })

  it('keeps different headlines distinct', () => {
    expect(normalizeTitle('Rust released')).not.toBe(normalizeTitle('Go released'))
  })

  it('handles CJK', () => {
    expect(normalizeTitle('「早报」今日要闻')).toBe('早报 今日要闻')
  })
})

describe('dedupe', () => {
  it('keeps the first of two items sharing a canonical URL', () => {
    const a = rawItem({ url: 'https://a.com/x', title: 'First', source: 'hn-front' })
    const b = rawItem({
      url: 'https://www.a.com/x/?utm_source=rss',
      title: 'Second',
      source: 'verge',
    })
    const result = dedupe([
      { ...a, id: itemId(a.url) },
      { ...b, id: itemId(b.url) },
    ])
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.title).toBe('First')
    expect(result.droppedWithinRun).toBe(1)
  })

  it('drops a near-identical title even at a different URL', () => {
    const a = rawItem({ url: 'https://a.com/1', title: 'OpenAI ships GPT-9', id: 'a' })
    const b = rawItem({ url: 'https://b.com/2', title: 'openai ships gpt 9!', id: 'b' })
    expect(dedupe([a, b]).items).toHaveLength(1)
  })

  it('A7 — drops anything already present in the archive', () => {
    const seen = seenFromArchive([{ id: 'x1', title: 'Yesterday news' }])
    const today = [
      rawItem({ id: 'x1', title: 'Yesterday news' }),
      rawItem({ id: 'x2', title: 'Fresh' }),
    ]
    const result = dedupe(today, seen)
    expect(result.items.map((i) => i.id)).toEqual(['x2'])
    expect(result.droppedAsSeen).toBe(1)
  })

  it('A7 — matches an archived item by title even when the URL changed', () => {
    const seen = seenFromArchive([{ id: 'other', title: 'Yesterday News!' }])
    const result = dedupe([rawItem({ id: 'x2', title: 'yesterday news' })], seen)
    expect(result.items).toHaveLength(0)
    expect(result.droppedAsSeen).toBe(1)
  })

  it('preserves input order for everything it keeps', () => {
    const items = [rawItem({ id: '1' }), rawItem({ id: '2' }), rawItem({ id: '3' })]
    expect(dedupe(items).items.map((i) => i.id)).toEqual(['1', '2', '3'])
  })

  it('an empty archive drops nothing', () => {
    const items = [rawItem({ id: '1' }), rawItem({ id: '2' })]
    expect(dedupe(items, seenFromArchive([])).items).toHaveLength(2)
  })
})
