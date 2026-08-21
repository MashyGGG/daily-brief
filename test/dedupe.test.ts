import { describe, expect, it } from 'vitest'
import { canonicalizeUrl, itemId, normalizeTitle } from '../src/core/normalize'
import { dedupe, emptySeen, seenFromArchive } from '../src/core/dedupe'
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

describe('near-duplicate titles — §0.3 跨源同题', () => {
  // The real 2026-08-21 regression: oschina and 36kr-ai each rewrote the same DeepSeek
  // Harness story, so `cn-tech` spent two of its five seats on one piece of news.
  const OSCHINA = 'DeepSeek Harness 公测一周迎来多模态大招，纯文本模型也能“看图”了'
  const KR36 =
    'DeepSeek Harness一周三更：把Claude Code和Codex收编成子代理，要当Agent时代的“调度层”？'
  const THRESHOLD = 0.2

  const pair = (a: string, b: string) => [
    rawItem({ id: 'a', url: 'https://a.com/1', title: a }),
    rawItem({ id: 'b', url: 'https://b.com/2', title: b }),
  ]

  it('collapses the same story rewritten by a second Chinese outlet', () => {
    const result = dedupe(pair(OSCHINA, KR36), emptySeen(), THRESHOLD)
    expect(result.items.map((i) => i.title)).toEqual([OSCHINA])
    expect(result.droppedWithinRun).toBe(1)
  })

  it('keeps both when the check is switched off, which is the pre-M0 behaviour', () => {
    expect(dedupe(pair(OSCHINA, KR36), emptySeen(), 0).items).toHaveLength(2)
  })

  it('leaves two unrelated stories from one outlet alone once the suffix is stripped', () => {
    // With ` - thepaper.cn` still attached these two score 0.327 — above the DeepSeek pair's
    // 0.286 — which is why `sources[].stripPatterns` has to run before this check.
    const items = pair('具身智能寻找评测“标尺”', '罗昊：现在谈AI泡沫破裂还为时过早，因为基本面还在')
    expect(dedupe(items, emptySeen(), THRESHOLD).items).toHaveLength(2)
  })

  it('does not collapse two releases of the same project — the numbers disagree', () => {
    const items = pair('Announcing Rust 1.98.0', 'Announcing Rust 1.99.0')
    expect(dedupe(items, emptySeen(), THRESHOLD).items).toHaveLength(2)
  })

  it('does not collapse two tags from one release feed — too short to score', () => {
    const items = pair('v4.1.1', 'v4.0.8')
    expect(dedupe(items, emptySeen(), THRESHOLD).items).toHaveLength(2)
  })

  it('still collapses a rewrite that carries the same numbers', () => {
    const items = pair(
      'OpenAI ships GPT-9 to every paying customer today',
      'OpenAI ships GPT-9 to every paying customer, starting today',
    )
    expect(dedupe(items, emptySeen(), THRESHOLD).items).toHaveLength(1)
  })

  it('reaches across days through the archive, not just within one run', () => {
    const seen = seenFromArchive([{ id: 'archived', title: OSCHINA }])
    const result = dedupe([rawItem({ id: 'fresh', title: KR36 })], seen, THRESHOLD)
    expect(result.items).toHaveLength(0)
    expect(result.droppedAsSeen).toBe(1)
  })

  it('counts a near-duplicate of a dropped item once, against the survivor', () => {
    const items = [
      rawItem({ id: 'a', url: 'https://a.com/1', title: OSCHINA }),
      rawItem({ id: 'b', url: 'https://b.com/2', title: KR36 }),
      rawItem({ id: 'c', url: 'https://c.com/3', title: KR36 + '（转载）' }),
    ]
    const result = dedupe(items, emptySeen(), THRESHOLD)
    expect(result.items).toHaveLength(1)
    expect(result.droppedWithinRun).toBe(2)
  })
})
