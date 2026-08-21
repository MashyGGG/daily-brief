import { describe, expect, it } from 'vitest'
import {
  escapeMarkdown,
  renderArchiveMarkdown,
  renderMarkdown,
  renderMarkdownBlocks,
} from '../src/render/markdown'
import { escapeHtml, renderHtml, safeHref } from '../src/render/html'
import { renderText } from '../src/render/text'
import { render, renderForRecipients } from '../src/render'
import type { Brief } from '../src/core/brief'
import type { Recipient } from '../src/config/schema'
import { item, NOW } from './helpers'

const brief = (over: Partial<Brief> = {}): Brief => ({
  date: '2026-08-20',
  scheduleId: 'morning',
  slot: null,
  title: '每日早报',
  timezone: 'Asia/Shanghai',
  generatedAt: NOW.toISOString(),
  lookbackHours: 24,
  sections: [
    { id: 'tech', title: '国际技术', items: [item({ id: 't1', title: 'Rust 1.90' })] },
    { id: 'news', title: '国际要闻', items: [] },
  ],
  warnings: [],
  ...over,
})

describe('markdown rendering', () => {
  it('escapes the control characters that show up in real headlines', () => {
    expect(escapeMarkdown('a *b* [c] <d> _e_ `f`')).toBe(
      'a \\*b\\* \\[c\\] \\<d\\> \\_e\\_ \\`f\\`',
    )
  })

  it('renders a title containing markdown syntax without breaking the link', () => {
    const out = renderMarkdown(
      brief({
        sections: [
          {
            id: 'tech',
            title: '国际技术',
            items: [item({ title: 'A *very* [odd] <title>', url: 'https://a.com/x' })],
          },
        ],
      }),
    )
    expect(out).toContain('\\*very\\*')
    expect(out).toContain('](https://a.com/x)')
  })

  it('drops a section with no items instead of rendering an empty heading', () => {
    const out = renderMarkdown(brief())
    expect(out).toContain('国际技术')
    expect(out).not.toContain('国际要闻')
  })

  it('emits one block per item so the chunker can pack them', () => {
    const blocks = renderMarkdownBlocks(
      brief({
        sections: [
          {
            id: 'tech',
            title: '国际技术',
            items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })],
          },
        ],
      }),
    )
    // header + section heading + 3 items + footer
    expect(blocks).toHaveLength(6)
  })

  it('includes warnings when present', () => {
    expect(renderMarkdown(brief({ warnings: ['source "verge" failed: HTTP 500'] }))).toContain(
      'HTTP 500',
    )
  })
})

describe('html rendering', () => {
  it('escapes HTML in titles', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    )
  })

  it('never emits an unescaped angle bracket from a hostile title', () => {
    const out = renderHtml(
      brief({
        sections: [
          {
            id: 'tech',
            title: '国际技术',
            items: [item({ title: '<img src=x onerror=alert(1)>' })],
          },
        ],
      }),
    )
    expect(out).not.toContain('<img src=x')
    expect(out).toContain('&lt;img src=x')
  })

  it('neutralises a javascript: href', () => {
    expect(safeHref('javascript:alert(1)')).toBe('#')
    expect(safeHref('data:text/html,<script>')).toBe('#')
    expect(safeHref('https://a.com/x')).toBe('https://a.com/x')
  })

  it('is self-contained — no remote stylesheet, script or image', () => {
    const out = renderHtml(brief())
    expect(out).not.toMatch(/<link[^>]+stylesheet/i)
    expect(out).not.toMatch(/<script/i)
    expect(out).not.toMatch(/<img/i)
  })

  it('skips an empty section', () => {
    expect(renderHtml(brief())).not.toContain('国际要闻')
  })
})

describe('text rendering', () => {
  it('carries the URL for every item', () => {
    const out = renderText(brief())
    expect(out).toContain('Rust 1.90')
    expect(out).toContain('https://example.com/')
  })
})

describe('renderForRecipients', () => {
  const recipient = (over: Partial<Recipient>): Recipient => ({
    id: 'r',
    channel: 'wecom',
    sections: ['*'],
    format: 'markdown',
    enabled: true,
    ...over,
  })

  it('A3 — restricts each recipient to the sections they subscribe to', () => {
    const full = brief({
      sections: [
        { id: 'tech', title: '国际技术', items: [item({ id: 't', title: 'TECH ITEM' })] },
        { id: 'news', title: '国际要闻', items: [item({ id: 'n', title: 'NEWS ITEM' })] },
      ],
    })
    const out = renderForRecipients(full, [
      recipient({ id: 'tech-only', sections: ['tech'] }),
      recipient({ id: 'both', sections: ['*'] }),
    ])
    expect(out.get('tech-only')!.body).toContain('TECH ITEM')
    expect(out.get('tech-only')!.body).not.toContain('NEWS ITEM')
    expect(out.get('both')!.body).toContain('NEWS ITEM')
  })

  it('renders once per (sections, format) signature, not once per recipient', () => {
    const out = renderForRecipients(brief(), [
      recipient({ id: 'a', sections: ['tech'], format: 'markdown' }),
      recipient({ id: 'b', sections: ['tech'], format: 'markdown' }),
      recipient({ id: 'c', sections: ['tech'], format: 'html' }),
    ])
    expect(out.get('a')).toBe(out.get('b'))
    expect(out.get('a')).not.toBe(out.get('c'))
  })

  it('treats section order as irrelevant to the signature', () => {
    const out = renderForRecipients(brief(), [
      recipient({ id: 'a', sections: ['tech', 'news'] }),
      recipient({ id: 'b', sections: ['news', 'tech'] }),
    ])
    expect(out.get('a')).toBe(out.get('b'))
  })

  it('always supplies a plain-text alternative alongside HTML', () => {
    const rendered = render(brief(), 'html')
    expect(rendered.body).toMatch(/^<!doctype html>/)
    expect(rendered.text).toContain('Rust 1.90')
    expect(rendered.text).not.toContain('<html')
  })
})

describe('§1.2 — the LLM summary is rendered, the excerpt is the fallback', () => {
  const summarized = item({
    title: 'Rust ships a new borrow checker',
    url: 'https://example.com/rust',
    excerpt: 'The original feed description, which nobody wanted to read.',
    summary: '新的借用检查器把编译期错误提示改写成了人话。',
    takeaways: ['误报更少', '编译更快'],
  })
  const plain = item({ title: 'No LLM here', excerpt: 'Just the feed text.' })
  const withBoth = brief({
    sections: [{ id: 'tech', title: '国际技术', items: [summarized, plain] }],
  })

  it('markdown prints the summary instead of the excerpt', () => {
    const out = renderMarkdown(withBoth)
    expect(out).toContain('新的借用检查器把编译期错误提示改写成了人话。')
    expect(out).not.toContain('which nobody wanted to read')
  })

  it('markdown still prints the excerpt for an item the LLM never touched', () => {
    expect(renderMarkdown(withBoth)).toContain('Just the feed text.')
  })

  it('renders everything it has when nobody says otherwise', () => {
    // M1 kept takeaways out of every markdown render because WeCom could not afford them.
    // §5.2 turned that from a rule into a per-recipient choice, so the default is now
    // "print what the enrich stage produced" and the phone copy asks for less explicitly.
    expect(renderMarkdown(withBoth)).toContain('误报更少')
  })

  it('the archived markdown keeps them, having no such ceiling', () => {
    const archived = renderArchiveMarkdown(withBoth)
    expect(archived).toContain('误报更少')
    expect(archived).toContain('编译更快')
  })

  it('mail prints the summary and the bullets', () => {
    const html = renderHtml(withBoth)
    expect(html).toContain('新的借用检查器把编译期错误提示改写成了人话。')
    expect(html).toContain('<li>误报更少</li>')
  })

  it('§5.3 — the mail keeps the source excerpt underneath, folded away', () => {
    const html = renderHtml(withBoth, { detail: 'full' })
    expect(html).toContain('原文摘要')
    expect(html).toContain('which nobody wanted to read')
    // The label sits above the summary's own paragraph, not in front of it.
    expect(html.indexOf('新的借用检查器')).toBeLessThan(html.indexOf('原文摘要'))
  })

  it('does not print the excerpt twice when it IS the body', () => {
    const only = brief({
      sections: [{ id: 'tech', title: 'T', items: [plain] }],
    })
    const html = renderHtml(only, { detail: 'full' })
    expect(html).toContain('Just the feed text.')
    expect(html).not.toContain('原文摘要')
  })

  it('plain text — the mail fallback — carries both too', () => {
    const text = renderText(withBoth)
    expect(text).toContain('新的借用检查器把编译期错误提示改写成了人话。')
    expect(text).toContain('- 误报更少')
  })

  it('escapes a summary the way it escapes a title', () => {
    const risky = brief({
      sections: [
        { id: 'tech', title: 'T', items: [item({ summary: 'a *b* [c] <d>', excerpt: 'x' })] },
      ],
    })
    expect(renderMarkdown(risky)).toContain('a \\*b\\* \\[c\\] \\<d\\>')
  })
})

describe('§5.2 — recipients[].detail', () => {
  const long =
    '新的借用检查器把编译期错误提示改写成了人话。它同时把误报率降到了上一版的三分之一。' +
    '官方博客说这项改动酝酿了两年，涉及编译器前端的大范围重写，并且不影响现有代码的兼容性。'
  const heavy = brief({
    sections: [
      {
        id: 'tech',
        title: '国际技术',
        items: [
          item({
            title: 'Rust ships a new borrow checker',
            summary: long,
            takeaways: ['误报更少', '编译更快', '不破坏兼容性'],
            excerpt: 'The original feed description.',
          }),
        ],
      },
    ],
  })

  it('compact cuts the body to the configured budget and drops the bullets', () => {
    const out = renderMarkdown(heavy, { detail: 'compact', compactMaxChars: 40 })
    expect(out).toContain('新的借用检查器把编译期错误提示改写成了人话。')
    expect(out).not.toContain('酝酿了两年')
    expect(out).not.toContain('误报更少')
  })

  it('compact cuts at a sentence boundary, not mid-thought', () => {
    const out = renderMarkdown(heavy, { detail: 'compact', compactMaxChars: 30 })
    // 30 chars of budget over a first sentence that ends at 22: the whole sentence stops
    // there, and the reader never sees a half-finished clause or a stray ellipsis.
    expect(out).toContain('人话。')
    expect(out).not.toContain('它同时把误报率')
    expect(out).not.toContain('…')
  })

  it('full keeps everything', () => {
    const out = renderMarkdown(heavy, { detail: 'full' })
    expect(out).toContain('酝酿了两年')
    expect(out).toContain('误报更少')
  })

  it('compact html drops the bullets and the folded excerpt too', () => {
    const out = renderHtml(heavy, { detail: 'compact', compactMaxChars: 40 })
    expect(out).not.toContain('<li>误报更少</li>')
    expect(out).not.toContain('原文摘要')
  })

  it('compact plain text drops the bullets', () => {
    const out = renderText(heavy, { detail: 'compact', compactMaxChars: 40 })
    expect(out).not.toContain('- 误报更少')
  })

  it('an unset detail follows the channel — push is a nudge, mail is the read', () => {
    const wecom: Recipient = {
      id: 'w',
      channel: 'wecom',
      sections: ['*'],
      format: 'markdown',
      enabled: true,
    }
    const mail: Recipient = {
      id: 'm',
      channel: 'email',
      sections: ['*'],
      format: 'markdown',
      enabled: true,
    }
    const out = renderForRecipients(heavy, [wecom, mail], {
      excerptMaxChars: 300,
      compactMaxChars: 40,
    })
    expect(out.get('w')!.body).not.toContain('误报更少')
    expect(out.get('m')!.body).toContain('误报更少')
  })

  it('an explicit detail wins over the channel default', () => {
    const wecom: Recipient = {
      id: 'w',
      channel: 'wecom',
      sections: ['*'],
      format: 'markdown',
      detail: 'full',
      enabled: true,
    }
    const out = renderForRecipients(heavy, [wecom], { excerptMaxChars: 300, compactMaxChars: 40 })
    expect(out.get('w')!.body).toContain('误报更少')
  })

  it('detail is part of the render cache key — two recipients must not collide on it', () => {
    // Same sections, same format: without `detail` in the key, whichever rendered first
    // would silently hand its document to the other one.
    const a: Recipient = {
      id: 'a',
      channel: 'wecom',
      sections: ['*'],
      format: 'markdown',
      enabled: true,
    }
    const b: Recipient = { ...a, id: 'b', channel: 'stdout' }
    const out = renderForRecipients(heavy, [a, b], { excerptMaxChars: 300, compactMaxChars: 40 })
    expect(out.get('a')!.body).not.toBe(out.get('b')!.body)
  })

  it('still renders once for recipients that share the whole signature', () => {
    const a: Recipient = {
      id: 'a',
      channel: 'wecom',
      sections: ['*'],
      format: 'markdown',
      enabled: true,
    }
    const b: Recipient = { ...a, id: 'b' }
    const out = renderForRecipients(heavy, [a, b])
    expect(out.get('a')).toBe(out.get('b'))
  })
})
