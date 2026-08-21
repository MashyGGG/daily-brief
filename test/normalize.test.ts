import { describe, expect, it } from 'vitest'
import {
  compileStripPatterns,
  normalize,
  stripBoilerplate,
  stripHtml,
  toExcerpt,
  truncate,
} from '../src/core/normalize'
import { NOW } from './helpers'

const strip = (...patterns: string[]) => compileStripPatterns(patterns)

// Character classes stand in for the escapes the real config uses ([ ] for whitespace,
// [.] for a literal dot) so these literals stay readable inside a TS string.
const GITHUB_TAIL = '[ ]*The post .{0,200}?appeared first on The GitHub Blog[.]?[ ]*$'
const THEPAPER_SUFFIX = '[ ]*[-–—]?[ ]*thepaper[.]cn[ ]*$'

describe('stripBoilerplate — §0.1 ① 样板污染', () => {
  it('removes the WordPress tail github.blog glues onto every changelog entry', () => {
    const raw =
      'Saved views can now be pinned to the issues sidebar. ' +
      'The post Pinning saved views is generally available appeared first on The GitHub Blog.'
    expect(stripBoilerplate(raw, strip(GITHUB_TAIL))).toBe(
      'Saved views can now be pinned to the issues sidebar.',
    )
  })

  it('leaves an excerpt that is nothing BUT boilerplate empty, so the item carries none', () => {
    expect(toExcerpt('点击查看原文>', 300, strip('点击查看原文>?'))).toBeUndefined()
    expect(
      toExcerpt('<a href="https://lobste.rs/s/x">Comments</a>', 300, strip('^Comments$')),
    ).toBeUndefined()
  })

  it('closes the gap it leaves behind rather than leaving a double space', () => {
    expect(stripBoilerplate('before NOISE after', strip('NOISE'))).toBe('before after')
  })

  it('is case-insensitive and global', () => {
    expect(stripBoilerplate('a AD b ad c', strip('ad'))).toBe('a b c')
  })

  it('reuses a compiled /g pattern across calls without skipping the second one', () => {
    const patterns = strip('noise')
    expect(stripBoilerplate('x noise', patterns)).toBe('x')
    expect(stripBoilerplate('y noise', patterns)).toBe('y')
  })

  it('applies to the title too — a shared suffix outscores a real cross-post at dedupe time', () => {
    const item = normalize(
      { title: '具身智能寻找评测“标尺” - thepaper.cn', url: 'https://a.com/1', source: 'thepaper' },
      NOW,
      { stripPatterns: strip(THEPAPER_SUFFIX) },
    )
    expect(item!.title).toBe('具身智能寻找评测“标尺”')
  })

  it('drops an item whose title a greedy pattern emptied — loudly, and only for that source', () => {
    const item = normalize({ title: 'Comments', url: 'https://a.com/1', source: 'lobsters' }, NOW, {
      stripPatterns: strip('^Comments$'),
    })
    expect(item).toBeNull()
  })
})

describe('truncate — §0.1 ② 截断难看', () => {
  it('returns a short text untouched', () => {
    expect(truncate('short enough', 300)).toBe('short enough')
  })

  it('ends on the last full English sentence inside the budget', () => {
    const text = 'First sentence here. Second one runs on for a while and would be cut mid-word.'
    expect(truncate(text, 40)).toBe('First sentence here.')
  })

  it('ends on the last full Chinese sentence inside the budget', () => {
    const text = '第一句话在这里。第二句话很长很长很长很长很长很长很长很长很长很长。'
    expect(truncate(text, 12)).toBe('第一句话在这里。')
  })

  it('prefers the ellipsis when the sentence break wastes over half the budget', () => {
    const text = '短句。' + '很长'.repeat(30)
    expect(truncate(text, 40)).toMatch(/…$/)
  })

  it('keeps the closing quote that belongs to the sentence it ends', () => {
    expect(truncate('他说：“可以。”然后走了，后面还有很长很长很长很长很长的一段话。', 16)).toBe(
      '他说：“可以。”',
    )
  })

  it('does not mistake a version number for a sentence end', () => {
    // "v1." fails on the character after the dot; a real sentence end needs whitespace.
    expect(truncate('Ship v1.2 today and tell everyone about it. Then rest.', 44)).toBe(
      'Ship v1.2 today and tell everyone about it.',
    )
  })

  it('does not mistake a dotted abbreviation for a sentence end', () => {
    const text = 'Ship it today, e.g. right now, because the rest of this line is filler text.'
    // The ellipsis, not a cut at 'e.g.' — the word-boundary fallback took over.
    expect(truncate(text, 30)).toBe('Ship it today, e.g. right…')
  })

  it('falls back to a word boundary plus an ellipsis when no sentence fits', () => {
    const out = truncate('alpha bravo charlie delta echo foxtrot golf hotel', 30)
    expect(out).toBe('alpha bravo charlie delta…')
    expect([...out].length).toBeLessThanOrEqual(30)
  })

  it('hard-cuts CJK, which has no spaces to fall back to', () => {
    const out = truncate('一二三四五六七八九十一二三四五六七八九十', 10)
    expect([...out]).toHaveLength(10)
    expect(out.endsWith('…')).toBe(true)
  })

  it('never exceeds the budget, sentence or not', () => {
    const text = 'A short one. ' + 'x'.repeat(500)
    expect([...truncate(text, 50)].length).toBeLessThanOrEqual(50)
  })

  it('counts code points, so an emoji costs one character and is never split', () => {
    const out = truncate('🙂'.repeat(20), 10)
    expect([...out]).toHaveLength(10)
    expect(out).not.toContain(String.fromCharCode(0xfffd))
  })
})

describe('normalize — the render budget reaches the source', () => {
  it('honours excerptMaxChars over the built-in default', () => {
    const item = normalize(
      {
        title: 'T',
        url: 'https://a.com/1',
        source: 's',
        excerpt: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
      },
      NOW,
      { excerptMaxChars: 40 },
    )
    expect([...item!.excerpt!].length).toBeLessThanOrEqual(40)
  })

  it('strips HTML before matching a pattern against the text', () => {
    const item = normalize(
      { title: 'T', url: 'https://a.com/1', source: 's', excerpt: '<p>keep</p> <b>drop</b>' },
      NOW,
      { stripPatterns: strip('drop') },
    )
    expect(item!.excerpt).toBe('keep')
  })
})

describe('§9 M2 — decodeEntities', () => {
  it('decodes the punctuation that used to survive into a summary looking like a bug', () => {
    expect(stripHtml('a &mdash; b &ndash; c &hellip;')).toBe('a \u2014 b \u2013 c \u2026')
    expect(stripHtml('&ldquo;quoted&rdquo; and it&rsquo;s fine')).toBe(
      '\u201cquoted\u201d and it\u2019s fine',
    )
  })

  it('keeps the numeric forms working', () => {
    expect(stripHtml('&#8212; &#x2014;')).toBe('\u2014 \u2014')
  })

  it('tells &Prime; from &prime; — the table is case-significant', () => {
    expect(stripHtml('&prime; &Prime;')).toBe('\u2032 \u2033')
  })

  it('leaves an entity it does not know rather than mangling it', () => {
    expect(stripHtml('&notarealentity; stays')).toBe('&notarealentity; stays')
  })
})
