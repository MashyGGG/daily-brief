import { describe, expect, it } from 'vitest'
import {
  adapt,
  briefFor,
  contentHash,
  issueUrl,
  renderBody,
  renderFooter,
  renderTitle,
  resolveCanonicalBase,
  resolveTags,
  resolveTarget,
} from '../src/publish/adapt'
import { parseConfig, publishTargetSchema, type BriefConfig } from '../src/config/schema'
import type { CollectedIssue } from '../src/publish/types'
import { item } from './helpers'

const CONFIG_YAML = `
timezone: Asia/Shanghai
title: 每日早报
schedules:
  - id: morning
    time: '07:10'
  - id: evening
    time: '20:10'
sources:
  - name: hn-front
    type: hackernews
    params: { mode: front_page, minPoints: 100 }
sections:
  - id: tech
    title: 国际技术
    sources: [hn-front]
    limit: 6
recipients:
  - id: me-wecom
    channel: wecom
    secretRef: WECOM_WEBHOOK_ME
publish:
  enabled: true
  include: [tech]
  schedules:
    - id: daily
      time: '09:30'
      window: { days: 1, slots: [morning, evening] }
      titleTemplate: '{title} · 技术日报（{date}）'
      tags: [前端, AI]
    - id: weekly
      time: '10:30'
      weekday: mon
      window: { days: 1, slots: [weekly] }
      titleTemplate: '{title} · 周报（{range}）'
      tags: [周报]
  targets:
    - id: juejin
      platform: juejin
      secretRef: JUEJIN_COOKIE
      schedules: ['*']
      juejin: { categoryId: 'C1', tagIds: ['T1', 'T2'] }
      overrides:
        weekly:
          tags: [周报, 前端]
          juejin: { tagIds: ['T1'] }
`

const config = (): BriefConfig => parseConfig(CONFIG_YAML, {})

const issue = (over: Partial<CollectedIssue> = {}): CollectedIssue => ({
  scheduleId: 'daily',
  publishDate: '2026-08-22',
  sources: [
    { date: '2026-08-22', slot: 'morning' },
    { date: '2026-08-22', slot: 'evening' },
  ],
  sections: [
    {
      id: 'tech',
      title: '国际技术',
      items: [
        item({
          id: 'a',
          // Every character `escapeMarkdown` would touch, in one title.
          title: 'A [bracket] `code` <tag> _under_ *star*',
          url: 'https://example.com/a',
          source: 'hn-front',
          excerpt: 'body with [brackets]',
        }),
      ],
    },
  ],
  itemIds: ['a'],
  range: '2026-08-22',
  ...over,
})

const BASE = 'https://mashyggg.github.io/daily-brief'
const REPO = 'https://github.com/MashyGGG/daily-brief'

describe('publish/adapt — the escaping is genuinely off (§3.1 / §3.2)', () => {
  it('emits no backslash escapes anywhere in the body', () => {
    const body = renderBody(issue(), { footer: false, base: BASE, repoUrl: REPO })
    expect(body).toContain('A [bracket] `code` <tag> _under_ *star*')
    expect(body).not.toContain('\\[')
    expect(body).not.toContain('\\`')
    // Nothing weaker: platform markdown must carry no backslash at all.
    expect(body).not.toContain('\\')
  })

  it('carries none of the run metadata the archived copy has', () => {
    const body = renderBody(issue(), { footer: true, base: BASE, repoUrl: REPO })
    expect(body).not.toContain('生成时间')
    expect(body).not.toContain('时段：')
    expect(body).not.toContain('## 告警')
  })

  it('emits no h1: the title travels in its own field and 掘金 prints it above the body', () => {
    const body = renderBody(issue(), { footer: true, base: BASE, repoUrl: REPO })
    expect(body.split('\n').some((l) => /^#\s/.test(l))).toBe(false)
    expect(body).toContain('## 国际技术')
  })
})

describe('publish/adapt — the footer (§3.4)', () => {
  it('lists every source issue with an absolute link', () => {
    const footer = renderFooter(issue(), BASE, REPO)
    expect(footer).toContain(`${BASE}/2026/08/2026-08-22.morning.html`)
    expect(footer).toContain(`${BASE}/2026/08/2026-08-22.evening.html`)
    expect(footer).toContain('早报')
    expect(footer).toContain('晚报')
    // The editorial line is the part that makes this a digest rather than a scrape.
    expect(footer).toContain('只收录技术条目')
    expect(footer).toContain(`${BASE}/index.html`)
  })

  it('is omitted when the target turns it off', () => {
    const body = renderBody(issue(), { footer: false, base: BASE, repoUrl: REPO })
    expect(body).not.toContain('自动整理')
  })
})

describe('publish/adapt — field derivation (§3.3)', () => {
  it('uses the digest for the teaser when there is one', () => {
    const withDigest = issue({
      digest: {
        text: '今天讲的是三件事。',
        meta: { by: 'llm', model: 'm', promptVersion: 'v1', inputKind: 'summaries' },
      },
    })
    expect(briefFor(withDigest)).toBe('今天讲的是三件事。')
  })

  it('degrades to leading titles when no digest exists — the pre-M3 archives', () => {
    const brief = briefFor(issue())
    expect(brief).not.toBe('')
    expect(brief).toContain('A [bracket]')
    expect([...brief].length).toBeLessThanOrEqual(100)
  })

  it('fills the title template and nothing else', () => {
    expect(renderTitle('{title} · 技术日报（{date}）', { title: 'T', date: 'D', range: 'R' })).toBe(
      'T · 技术日报（D）',
    )
    expect(renderTitle('{title} {nope}', { title: 'T' })).toBe('T {nope}')
  })

  it('points canonical at the newest source issue', () => {
    const article = adapt({
      config: config(),
      schedule: config().publish.schedules[0]!,
      issue: issue(),
      target: config().publish.targets[0]!,
      repository: 'MashyGGG/daily-brief',
    })
    expect(article.canonicalUrl).toBe(`${BASE}/2026/08/2026-08-22.evening.html`)
    expect(article.title).toBe('每日早报 · 技术日报（2026-08-22）')
    expect(article.tags).toEqual(['前端', 'AI'])
  })

  it('derives the Pages base from the repository, and lets an override win', () => {
    expect(resolveCanonicalBase({ configured: '', repository: 'MashyGGG/daily-brief' })).toBe(BASE)
    expect(resolveCanonicalBase({ configured: 'https://x.dev/', repository: 'a/b' })).toBe(
      'https://x.dev',
    )
    expect(
      resolveCanonicalBase({
        configured: 'https://x.dev',
        override: 'https://y.dev',
        repository: 'a/b',
      }),
    ).toBe('https://y.dev')
  })

  it('builds the same issue path the site builder writes', () => {
    expect(issueUrl(BASE, '2026-08-22', 'morning')).toBe(`${BASE}/2026/08/2026-08-22.morning.html`)
    expect(issueUrl(BASE, '2026-08-20', null)).toBe(`${BASE}/2026/08/2026-08-20.html`)
  })
})

describe('publish/adapt — contentHash (§4.3)', () => {
  it('covers exactly title + brief + markdown', () => {
    const a = contentHash({ title: 'T', brief: 'B', markdown: 'M' })
    expect(a).toHaveLength(16)
    expect(contentHash({ title: 'T', brief: 'B', markdown: 'M' })).toBe(a)
    expect(contentHash({ title: 'T2', brief: 'B', markdown: 'M' })).not.toBe(a)
    expect(contentHash({ title: 'T', brief: 'B2', markdown: 'M' })).not.toBe(a)
    expect(contentHash({ title: 'T', brief: 'B', markdown: 'M2' })).not.toBe(a)
  })

  it('does not move when only the tags change — relabelling must not mean republishing', () => {
    const cfg = config()
    const daily = cfg.publish.schedules[0]!
    const one = adapt({
      config: cfg,
      schedule: daily,
      issue: issue(),
      target: cfg.publish.targets[0]!,
      repository: 'a/b',
    })
    const other = adapt({
      config: cfg,
      schedule: { ...daily, tags: ['完全不同的标签'] },
      issue: issue(),
      target: cfg.publish.targets[0]!,
      repository: 'a/b',
    })
    expect(other.tags).not.toEqual(one.tags)
    expect(other.contentHash).toBe(one.contentHash)
  })
})

describe('publish/adapt — per-line overrides', () => {
  it('shallow-merges only the keys the override names', () => {
    const target = config().publish.targets[0]!
    const weekly = resolveTarget(target, 'weekly')
    expect(weekly.juejin!.tagIds).toEqual(['T1'])
    // The category was not overridden, so it must survive.
    expect(weekly.juejin!.categoryId).toBe('C1')
    expect(resolveTarget(target, 'daily').juejin!.tagIds).toEqual(['T1', 'T2'])
  })

  it('lets the override replace the tags the line would use', () => {
    const cfg = config()
    const target = cfg.publish.targets[0]!
    expect(resolveTags(cfg.publish.schedules[1]!, target)).toEqual(['周报', '前端'])
    expect(resolveTags(cfg.publish.schedules[0]!, target)).toEqual(['前端', 'AI'])
  })

  it('leaves an unrelated target untouched', () => {
    const target = publishTargetSchema.parse({
      id: 'x',
      platform: 'stdout',
      secretRef: 'NONE',
    })
    expect(resolveTarget(target, 'weekly')).toEqual(target)
  })
})
