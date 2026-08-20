import { describe, expect, it } from 'vitest'
import { escapeMarkdown, renderMarkdown, renderMarkdownBlocks } from '../src/render/markdown'
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
