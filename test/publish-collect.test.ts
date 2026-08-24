import { describe, expect, it } from 'vitest'
import { collect, renderExplain, slotRank, weekdayOf } from '../src/publish/collect'
import { memoryFs } from '../src/archive/fs'
import { parseConfig, type BriefConfig, type PublishSchedule } from '../src/config/schema'
import { item } from './helpers'
import type { Item } from '../src/config/schema'

/**
 * PUBLISH.md §9 — selection is the one part of this feature whose correctness cannot be
 * eyeballed on a run page. The FIRST test here is the one that matters most: not a single
 * news item may reach a published article.
 */

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
  - id: ai
    title: AI 工程
    sources: [hn-front]
    limit: 4
  - id: news
    title: 国际要闻
    sources: [hn-front]
    limit: 3
recipients:
  - id: me-wecom
    channel: wecom
    secretRef: WECOM_WEBHOOK_ME
publish:
  enabled: true
  include: [tech, ai]
  schedules:
    - id: daily
      time: '09:30'
      window: { days: 1, slots: [morning, evening] }
      minItems: 2
      maxItems: 30
      backfillDays: 0
    - id: weekly
      time: '10:30'
      weekday: mon
      window: { days: 1, slots: [weekly] }
      minItems: 1
      maxItems: 40
  targets:
    - id: out
      platform: stdout
      secretRef: NOTHING
      schedules: ['*']
`

function config(overrides: Partial<BriefConfig> = {}): BriefConfig {
  return { ...parseConfig(CONFIG_YAML, {}), ...overrides }
}

function line(cfg: BriefConfig, id: string): PublishSchedule {
  return cfg.publish.schedules.find((s) => s.id === id)!
}

function record(date: string, slot: string | null, items: Item[], digest?: unknown): string {
  return JSON.stringify({
    date,
    slot,
    scheduleId: slot ?? 'morning',
    generatedAt: `${date}T00:00:00.000Z`,
    configHash: 'abc',
    timezone: 'Asia/Shanghai',
    lookbackHours: 24,
    itemCount: items.length,
    items,
    ...(digest ? { digest } : {}),
    warnings: [],
  })
}

function archive(files: Record<string, string>) {
  return memoryFs(files)
}

describe('publish/collect — the section whitelist', () => {
  it('lets through zero news items, ever', () => {
    const cfg = config()
    const fs = archive({
      'archive/2026/08/2026-08-22.morning.json': record('2026-08-22', 'morning', [
        item({ id: 't1', section: 'tech', rankScore: 0.9 }),
        item({ id: 'n1', section: 'news', rankScore: 5 }),
        item({ id: 'n2', section: 'news', rankScore: 4 }),
        item({ id: 'a1', section: 'ai', rankScore: 0.5 }),
      ]),
    })

    const result = collect({
      config: cfg,
      schedule: line(cfg, 'daily'),
      publishDate: '2026-08-22',
      fs,
    })

    expect(result.issue).not.toBeNull()
    expect(result.issue!.itemIds).toEqual(['t1', 'a1'])
    expect(result.issue!.sections.map((s) => s.id)).toEqual(['tech', 'ai'])
    // Not merely absent from the output — never even a candidate, despite the top rank.
    expect(result.issue!.sections.some((s) => s.id === 'news')).toBe(false)
    expect(result.explain.rows[0]!.total).toBe(4)
    expect(result.explain.rows[0]!.included).toBe(2)
  })

  it('ignores a section that is whitelisted but does not exist in the archive', () => {
    const cfg = config()
    const fs = archive({
      'archive/2026/08/2026-08-22.morning.json': record('2026-08-22', 'morning', [
        item({ id: 'x', section: 'finance', rankScore: 9 }),
        item({ id: 't1', section: 'tech', rankScore: 1 }),
        item({ id: 't2', section: 'tech', rankScore: 1 }),
      ]),
    })
    const result = collect({
      config: cfg,
      schedule: line(cfg, 'daily'),
      publishDate: '2026-08-22',
      fs,
    })
    expect(result.issue!.itemIds).toEqual(['t1', 't2'])
  })
})

describe('publish/collect — the window', () => {
  it('merges morning and evening into one publication', () => {
    const cfg = config()
    const fs = archive({
      'archive/2026/08/2026-08-22.morning.json': record('2026-08-22', 'morning', [
        item({ id: 'm1', section: 'tech', rankScore: 0.9 }),
        item({ id: 'm2', section: 'tech', rankScore: 0.8 }),
      ]),
      'archive/2026/08/2026-08-22.evening.json': record('2026-08-22', 'evening', [
        item({ id: 'e1', section: 'tech', rankScore: 0.95 }),
      ]),
    })
    const result = collect({
      config: cfg,
      schedule: line(cfg, 'daily'),
      publishDate: '2026-08-22',
      fs,
    })
    expect(result.issue!.itemIds).toEqual(['e1', 'm1', 'm2'])
    // Chronological, so the footer reads morning → evening and canonical picks evening.
    expect(result.issue!.sources).toEqual([
      { date: '2026-08-22', slot: 'morning' },
      { date: '2026-08-22', slot: 'evening' },
    ])
  })

  it('skips the weekly reprint when scanning a daily window', () => {
    const cfg = config()
    const fs = archive({
      'archive/2026/08/2026-08-24.morning.json': record('2026-08-24', 'morning', [
        item({ id: 'm1', section: 'tech', rankScore: 0.9 }),
        item({ id: 'm2', section: 'tech', rankScore: 0.8 }),
      ]),
      'archive/2026/08/2026-08-24.weekly.json': record('2026-08-24', 'weekly', [
        item({ id: 'w1', section: 'tech', rankScore: 5 }),
      ]),
    })
    const result = collect({
      config: cfg,
      schedule: line(cfg, 'daily'),
      publishDate: '2026-08-24',
      fs,
    })
    expect(result.issue!.itemIds).not.toContain('w1')
    expect(result.explain.rows).toHaveLength(1)
  })

  it('reads the weekly reprint when the weekly line asks for that slot by name', () => {
    const cfg = config()
    const fs = archive({
      'archive/2026/08/2026-08-24.morning.json': record('2026-08-24', 'morning', [
        item({ id: 'm1', section: 'tech', rankScore: 0.9 }),
      ]),
      'archive/2026/08/2026-08-24.weekly.json': record('2026-08-24', 'weekly', [
        item({ id: 'w1', section: 'tech', rankScore: 5 }),
      ]),
    })
    const result = collect({
      config: cfg,
      schedule: line(cfg, 'weekly'),
      publishDate: '2026-08-24',
      fs,
    })
    expect(result.issue!.itemIds).toEqual(['w1'])
  })

  it('reports "no archive" rather than failing when the brief has not run yet', () => {
    const cfg = config()
    const result = collect({
      config: cfg,
      schedule: line(cfg, 'daily'),
      publishDate: '2026-08-22',
      fs: archive({}),
    })
    expect(result.issue).toBeNull()
    expect(result.reason).toBe('no-archive')
    expect(result.detail).toMatch(/catchUpDays/)
  })
})

describe('publish/collect — dedupe, ranking and the minItems gate', () => {
  it('drops items an earlier publication carried — but only where backfill reached', () => {
    const cfg = config()
    const hungry = { ...line(cfg, 'daily'), minItems: 3, backfillDays: 2 }
    const fs = archive({
      // The line's own window. `old` went out yesterday and stays anyway: inside the
      // primary window an already-published id is not evidence of duplication.
      'archive/2026/08/2026-08-22.morning.json': record('2026-08-22', 'morning', [
        item({ id: 'old', section: 'tech', rankScore: 9 }),
        item({ id: 'new1', section: 'tech', rankScore: 1 }),
      ]),
      // Only reached because the window was short — here the check does apply.
      'archive/2026/08/2026-08-21.morning.json': record('2026-08-21', 'morning', [
        item({ id: 'stale', section: 'tech', rankScore: 8 }),
        item({ id: 'new2', section: 'tech', rankScore: 0.5 }),
      ]),
    })
    const result = collect({
      config: cfg,
      schedule: hungry,
      publishDate: '2026-08-22',
      publishedItemIds: ['old', 'stale'],
      fs,
    })
    expect(result.issue!.itemIds.sort()).toEqual(['new1', 'new2', 'old'])
    const window = result.explain.rows.find((r) => !r.backfill)!
    const backfilled = result.explain.rows.find((r) => r.backfill)!
    expect(window.alreadyPublished).toBe(0)
    expect(backfilled.alreadyPublished).toBe(1)
  })

  /**
   * The regression that made this rule what it is. A weekly review reprints the week's
   * items by definition, so with the filter on the primary window the daily line that had
   * already published them left the weekly line with 2 of 20 items and it skipped itself
   * — every Monday, silently, for as long as the dailies kept running.
   */
  it('still fills the weekly line after the dailies published the same items', () => {
    const cfg = config()
    const weekly = { ...line(cfg, 'weekly'), minItems: 3 }
    const week = ['a', 'b', 'c', 'd'].map((id, i) =>
      item({ id, section: 'tech', rankScore: 1 - i / 10 }),
    )
    const fs = archive({
      'archive/2026/08/2026-08-24.weekly.json': record('2026-08-24', 'weekly', week),
    })
    const result = collect({
      config: cfg,
      schedule: weekly,
      publishDate: '2026-08-24',
      // Exactly what six days of published dailies leave behind.
      publishedItemIds: ['a', 'b', 'c', 'd'],
      fs,
    })
    expect(result.reason).toBeUndefined()
    expect(result.issue!.itemIds.sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('caps at maxItems by rankScore, not by file order', () => {
    const cfg = config()
    const capped = { ...line(cfg, 'daily'), maxItems: 2 }
    const fs = archive({
      'archive/2026/08/2026-08-22.morning.json': record('2026-08-22', 'morning', [
        item({ id: 'low', section: 'tech', rankScore: 0.1 }),
        item({ id: 'high', section: 'tech', rankScore: 0.9 }),
        item({ id: 'mid', section: 'tech', rankScore: 0.5 }),
      ]),
    })
    const result = collect({ config: cfg, schedule: capped, publishDate: '2026-08-22', fs })
    expect(result.issue!.itemIds).toEqual(['high', 'mid'])
    expect(result.explain.cappedBy).toBe(1)
  })

  it('backfills into earlier days when the window is short', () => {
    const cfg = config()
    const hungry = { ...line(cfg, 'daily'), minItems: 3, backfillDays: 2 }
    const fs = archive({
      'archive/2026/08/2026-08-22.morning.json': record('2026-08-22', 'morning', [
        item({ id: 'a', section: 'tech', rankScore: 0.9 }),
      ]),
      'archive/2026/08/2026-08-21.morning.json': record('2026-08-21', 'morning', [
        item({ id: 'b', section: 'tech', rankScore: 0.8 }),
        item({ id: 'c', section: 'tech', rankScore: 0.7 }),
      ]),
    })
    const result = collect({ config: cfg, schedule: hungry, publishDate: '2026-08-22', fs })
    expect(result.issue!.itemIds.sort()).toEqual(['a', 'b', 'c'])
    expect(result.explain.backfillUsed).toBe(true)
    expect(result.explain.rows.some((r) => r.backfill)).toBe(true)
  })

  it('skips the whole line when backfill still cannot reach minItems', () => {
    const cfg = config()
    const hungry = { ...line(cfg, 'daily'), minItems: 5, backfillDays: 2 }
    const fs = archive({
      'archive/2026/08/2026-08-22.morning.json': record('2026-08-22', 'morning', [
        item({ id: 'a', section: 'tech', rankScore: 0.9 }),
      ]),
    })
    const result = collect({ config: cfg, schedule: hungry, publishDate: '2026-08-22', fs })
    expect(result.issue).toBeNull()
    expect(result.reason).toBe('too-few-items')
    // The table is what answers "why only 1 item" without adding logging and re-running.
    expect(renderExplain(result.explain)).toMatch(/候选 1 条/)
  })

  it('skips the line entirely on a skipWeekdays day', () => {
    const cfg = config()
    const noMondays = { ...line(cfg, 'daily'), skipWeekdays: ['mon' as const] }
    const fs = archive({
      'archive/2026/08/2026-08-24.morning.json': record('2026-08-24', 'morning', [
        item({ id: 'a', section: 'tech', rankScore: 0.9 }),
        item({ id: 'b', section: 'tech', rankScore: 0.8 }),
      ]),
    })
    const result = collect({ config: cfg, schedule: noMondays, publishDate: '2026-08-24', fs })
    expect(result.issue).toBeNull()
    expect(result.reason).toBe('skip-weekday')
  })

  it('takes the digest from the newest issue that has one', () => {
    const cfg = config()
    const digest = {
      text: '今天讲的是 X',
      meta: { by: 'llm', model: 'm', promptVersion: 'v1', inputKind: 'summaries' },
    }
    const fs = archive({
      'archive/2026/08/2026-08-22.morning.json': record('2026-08-22', 'morning', [
        item({ id: 'm1', section: 'tech', rankScore: 0.5 }),
      ]),
      'archive/2026/08/2026-08-22.evening.json': record(
        '2026-08-22',
        'evening',
        [item({ id: 'e1', section: 'tech', rankScore: 0.6 })],
        digest,
      ),
    })
    const result = collect({
      config: cfg,
      schedule: line(cfg, 'daily'),
      publishDate: '2026-08-22',
      fs,
    })
    expect(result.issue!.digest?.text).toBe('今天讲的是 X')
  })
})

describe('publish/collect — helpers', () => {
  it('names weekdays the way the config spells them', () => {
    expect(weekdayOf('2026-08-24')).toBe('mon')
    expect(weekdayOf('2026-08-22')).toBe('sat')
  })

  it('ranks slots by their schedule time, not alphabetically', () => {
    const cfg = config()
    // 'evening' < 'morning' alphabetically; by clock time it is the other way round.
    expect(slotRank(cfg, 'morning') < slotRank(cfg, 'evening')).toBe(true)
    expect(slotRank(cfg, null)).toBe('00:00')
  })
})
