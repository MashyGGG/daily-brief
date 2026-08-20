import { describe, expect, it } from 'vitest'
import { memoryFs } from '../src/archive/fs'
import type { ArchiveRecord } from '../src/archive/read'
import { collectIssues, groupByMonth, sectionsOf, type SiteIssue } from '../src/site/collect'
import {
  joinUrl,
  renderFeed,
  renderIndexPage,
  renderIssuePage,
  renderLatestRedirect,
  searchKey,
} from '../src/site/render'
import type { Item } from '../src/config/schema'
import { NOW } from './helpers'

function item(over: Partial<Item> = {}): Item {
  return {
    id: over.id ?? 'i1',
    title: over.title ?? 'Something happened',
    url: over.url ?? 'https://example.com/a',
    source: over.source ?? 'hn-front',
    section: over.section ?? 'tech',
    publishedAt: over.publishedAt ?? NOW.toISOString(),
    rankScore: over.rankScore ?? 0.5,
    ...(over.score !== undefined ? { score: over.score } : {}),
    ...(over.excerpt ? { excerpt: over.excerpt } : {}),
    ...(over.author ? { author: over.author } : {}),
  }
}

function record(over: Partial<ArchiveRecord> = {}): ArchiveRecord {
  const items = over.items ?? [item()]
  return {
    date: over.date ?? '2026-08-20',
    slot: over.slot ?? null,
    scheduleId: over.scheduleId ?? 'morning',
    generatedAt: over.generatedAt ?? NOW.toISOString(),
    configHash: over.configHash ?? 'da32268cf3b3',
    timezone: over.timezone ?? 'Asia/Shanghai',
    lookbackHours: over.lookbackHours ?? 24,
    itemCount: over.itemCount ?? items.length,
    items,
    warnings: over.warnings ?? [],
  }
}

function archiveFs(records: ArchiveRecord[], extra: Record<string, string> = {}) {
  const files: Record<string, string> = { ...extra }
  for (const r of records) {
    const [y, m] = r.date.split('-')
    const stem = r.slot ? `${r.date}.${r.slot}` : r.date
    files[`archive/${y}/${m}/${stem}.json`] = JSON.stringify(r)
  }
  return memoryFs(files)
}

const siteIssue = (r: ArchiveRecord): SiteIssue => {
  const [y, m] = r.date.split('-')
  const stem = r.slot ? `${r.date}.${r.slot}` : r.date
  return { record: r, path: `${y}/${m}/${stem}.html`, up: '../../' }
}

describe('collectIssues', () => {
  it('returns issues newest first, with html paths mirroring the archive layout', () => {
    const fs = archiveFs([record({ date: '2026-07-30' }), record({ date: '2026-08-20' })])
    const { issues, skipped } = collectIssues('archive', fs)
    expect(issues.map((i) => i.record.date)).toEqual(['2026-08-20', '2026-07-30'])
    expect(issues[0]!.path).toBe('2026/08/2026-08-20.html')
    expect(issues[0]!.up).toBe('../../')
    expect(skipped).toEqual([])
  })

  it('keeps both slots of a day, ordered by slot id', () => {
    const fs = archiveFs([
      record({ date: '2026-08-20', slot: 'morning' }),
      record({ date: '2026-08-20', slot: 'evening' }),
    ])
    const { issues } = collectIssues('archive', fs)
    expect(issues.map((i) => i.record.slot)).toEqual(['evening', 'morning'])
    expect(issues[1]!.path).toBe('2026/08/2026-08-20.morning.html')
  })

  it('skips a corrupt record instead of failing the build', () => {
    const fs = archiveFs([record({ date: '2026-08-20' })], {
      'archive/2026/08/2026-08-19.json': '{ not json',
    })
    const { issues, skipped } = collectIssues('archive', fs)
    expect(issues).toHaveLength(1)
    expect(skipped).toEqual(['archive/2026/08/2026-08-19.json'])
  })

  it('ignores directories that are not YYYY/MM and files that are not archives', () => {
    const fs = archiveFs([record()], {
      'archive/index.md': '# 早报归档',
      'archive/2026/08/2026-08-20.md': '# ignored',
      'archive/drafts/2026-08-01.json': '{}',
    })
    expect(collectIssues('archive', fs).issues).toHaveLength(1)
  })

  it('reports an empty archive rather than throwing', () => {
    expect(collectIssues('archive', memoryFs({}))).toEqual({ issues: [], skipped: [] })
  })
})

describe('sectionsOf', () => {
  const titles = { tech: '国际技术', news: '国际要闻' }

  it('groups items by section, in config order', () => {
    const r = record({
      items: [item({ id: 'a', section: 'news' }), item({ id: 'b', section: 'tech' })],
    })
    expect(sectionsOf(r, titles, ['tech', 'news']).map((s) => s.id)).toEqual(['tech', 'news'])
  })

  it('preserves item order inside a section', () => {
    const r = record({
      items: [item({ id: 'a', title: 'first' }), item({ id: 'b', title: 'second' })],
    })
    expect(sectionsOf(r, titles, ['tech'])[0]!.items.map((i) => i.title)).toEqual([
      'first',
      'second',
    ])
  })

  it('still renders a section that no longer exists in the config, under its raw id', () => {
    const r = record({ items: [item({ section: 'retired' })] })
    const sections = sectionsOf(r, titles, ['tech', 'news'])
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ id: 'retired', title: 'retired' })
  })

  it('sorts unknown sections after known ones', () => {
    const r = record({
      items: [item({ id: 'a', section: 'zzz' }), item({ id: 'b', section: 'news' })],
    })
    expect(sectionsOf(r, titles, ['tech', 'news']).map((s) => s.id)).toEqual(['news', 'zzz'])
  })
})

describe('groupByMonth', () => {
  it('buckets consecutive issues by YYYY-MM without reordering', () => {
    const issues = ['2026-08-20', '2026-08-01', '2026-07-31'].map((date) =>
      siteIssue(record({ date })),
    )
    expect(groupByMonth(issues).map((g) => [g.month, g.issues.length])).toEqual([
      ['2026-08', 2],
      ['2026-07', 1],
    ])
  })
})

describe('renderIssuePage', () => {
  const base = (over: Partial<ArchiveRecord> = {}) => {
    const r = record(over)
    const issue = siteIssue(r)
    return { siteTitle: '每日早报', issue, sections: sectionsOf(r, { tech: '国际技术' }, ['tech']) }
  }

  it('links assets and navigation relative to the page depth', () => {
    const html = renderIssuePage(base())
    expect(html).toContain('href="../../assets/style.css"')
    expect(html).toContain('href="../../index.html"')
    expect(html).not.toContain('href="/assets')
  })

  it('escapes headlines rather than letting them inject markup', () => {
    const html = renderIssuePage(base({ items: [item({ title: '<img src=x onerror=alert(1)>' })] }))
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
  })

  it('renders a non-http link inert', () => {
    const html = renderIssuePage(base({ items: [item({ url: 'javascript:alert(1)' })] }))
    expect(html).toContain('href="#"')
    expect(html).not.toContain('javascript:alert')
  })

  it('shows warnings when the run had them, and nothing when it did not', () => {
    expect(renderIssuePage(base({ warnings: ['rss verge: timeout'] }))).toContain('抓取告警')
    expect(renderIssuePage(base())).not.toContain('抓取告警')
  })

  it('says so plainly when an issue has no items', () => {
    const html = renderIssuePage({ ...base({ items: [] }), sections: [] })
    expect(html).toContain('这一期没有达标内容')
  })

  it('links older and newer neighbours when they exist', () => {
    const older = siteIssue(record({ date: '2026-08-19' }))
    const html = renderIssuePage({ ...base(), older })
    expect(html).toContain('href="../../2026/08/2026-08-19.html"')
    expect(html).toContain('← 更早')
  })
})

describe('renderIndexPage', () => {
  const issues = ['2026-08-20', '2026-07-31'].map((date) =>
    siteIssue(record({ date, items: [item({ title: `头条 ${date}` })] })),
  )

  it('lists every issue, grouped by month', () => {
    const html = renderIndexPage({ siteTitle: '每日早报', issues, builtAt: NOW.toISOString() })
    expect(html).toContain('data-month="2026-08"')
    expect(html).toContain('data-month="2026-07"')
    expect(html).toContain('href="2026/08/2026-08-20.html"')
  })

  it('carries a lowercased search key covering titles and dates', () => {
    const key = searchKey(
      siteIssue(record({ items: [item({ title: 'OpenRouter Joins Stripe' })] })),
    )
    expect(key).toContain('openrouter joins stripe')
    expect(key).toContain('2026-08-20')
  })

  it('handles an empty archive with a message, not a crash', () => {
    const html = renderIndexPage({ siteTitle: '每日早报', issues: [], builtAt: NOW.toISOString() })
    expect(html).toContain('暂无归档')
  })
})

describe('renderLatestRedirect', () => {
  it('points at the newest issue', () => {
    const html = renderLatestRedirect(siteIssue(record()), '每日早报')
    expect(html).toContain('url=2026/08/2026-08-20.html')
  })

  it('falls back to the index when there is nothing archived', () => {
    expect(renderLatestRedirect(undefined, '每日早报')).toContain('url=index.html')
  })
})

describe('joinUrl', () => {
  it('joins without doubling slashes', () => {
    expect(joinUrl('https://x.github.io/daily-brief/', '2026/08/a.html')).toBe(
      'https://x.github.io/daily-brief/2026/08/a.html',
    )
  })

  it('stays relative when no base is configured', () => {
    expect(joinUrl('', '2026/08/a.html')).toBe('2026/08/a.html')
  })
})

describe('renderFeed', () => {
  const issues = [record({ date: '2026-08-20' }), record({ date: '2026-08-19' })].map(siteIssue)

  it('emits absolute links when a base url is given', () => {
    const xml = renderFeed({
      siteTitle: '每日早报',
      issues,
      baseUrl: 'https://x.github.io/daily-brief/',
      builtAt: NOW.toISOString(),
    })
    expect(xml).toContain('<link>https://x.github.io/daily-brief/2026/08/2026-08-20.html</link>')
  })

  it('escapes the html body into the description', () => {
    const xml = renderFeed({
      siteTitle: '每日早报',
      issues: [siteIssue(record({ items: [item({ title: 'a & b' })] }))],
      baseUrl: '',
      builtAt: NOW.toISOString(),
    })
    expect(xml).toContain('&lt;ul&gt;')
    expect(xml).toContain('a &amp;amp; b')
  })

  it('caps the feed at `keep` issues', () => {
    const xml = renderFeed({
      siteTitle: '每日早报',
      issues,
      baseUrl: '',
      builtAt: NOW.toISOString(),
      keep: 1,
    })
    expect(xml.match(/<item>/g)).toHaveLength(1)
  })

  it('emits an RFC 822 pubDate', () => {
    const xml = renderFeed({
      siteTitle: '每日早报',
      issues,
      baseUrl: '',
      builtAt: NOW.toISOString(),
    })
    expect(xml).toContain('<pubDate>Thu, 20 Aug 2026 00:30:00 GMT</pubDate>')
  })
})
