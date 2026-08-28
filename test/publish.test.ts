import { describe, expect, it } from 'vitest'
import { publishAll, PUBLISHERS } from '../src/publish/index'
import { runPublish, targetsFor } from '../src/publish/run'
import { parsePublishArgs } from '../src/publish/cli'
import { readState, statePath } from '../src/publish/state'
import { memoryFs } from '../src/archive/fs'
import {
  parseConfig,
  publishTargetSchema,
  type BriefConfig,
  type PublishTarget,
} from '../src/config/schema'
import type { PlatformArticle, Publisher, PublisherContext } from '../src/publish/types'
import { item } from './helpers'
import type { Item } from '../src/config/schema'

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
  include: [tech]
  schedules:
    - id: daily
      time: '09:30'
      window: { days: 1, slots: [morning, evening] }
      minItems: 1
      maxItems: 30
      catchUpDays: 0
    - id: weekly
      time: '10:30'
      weekday: mon
      window: { days: 1, slots: [weekly] }
      minItems: 1
  targets:
    - id: out
      platform: stdout
      secretRef: NOTHING
      schedules: [daily]
    - id: weekly-only
      platform: stdout
      secretRef: NOTHING
      schedules: [weekly]
    - id: off
      platform: stdout
      secretRef: NOTHING
      enabled: false
      schedules: ['*']
`

const config = (): BriefConfig => parseConfig(CONFIG_YAML, {})

const ctx: PublisherContext = {
  env: {},
  sleep: async () => {},
  fetchImpl: async () => {
    throw new Error('no test may go online')
  },
  log: () => {},
}

const target = (over: Record<string, unknown> = {}): PublishTarget =>
  publishTargetSchema.parse({ id: 't', platform: 'stdout', secretRef: 'NONE', ...over })

const article = (over: Partial<PlatformArticle> = {}): PlatformArticle => ({
  scheduleId: 'daily',
  publishDate: '2026-08-22',
  title: 'T',
  markdown: 'body',
  brief: 'b',
  tags: [],
  canonicalUrl: 'https://x.dev/a.html',
  contentHash: 'HASH',
  ...over,
})

function record(date: string, slot: string | null, items: Item[]): string {
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
    warnings: [],
  })
}

describe('publish/index — isolation, copied from deliver()', () => {
  it('registers one factory per platform', () => {
    expect(Object.keys(PUBLISHERS).sort()).toEqual(['juejin', 'notion', 'stdout'])
  })

  it('lets one target fail without touching the other', async () => {
    const exploding: Publisher = {
      name: 'boom',
      missingEnv: () => [],
      createDraft: async () => {
        throw new Error('platform is down')
      },
      updateDraft: async () => {},
    }
    const custom = { ...PUBLISHERS }
    try {
      ;(PUBLISHERS as Record<string, unknown>).notion = () => exploding
      const outcomes = await publishAll(
        [
          {
            target: target({ id: 'bad', platform: 'notion', notion: { dataSourceRef: 'X' } }),
            resolved: target({ id: 'bad', platform: 'notion', notion: { dataSourceRef: 'X' } }),
            article: article(),
          },
          { target: target({ id: 'good' }), resolved: target({ id: 'good' }), article: article() },
        ],
        { ctx },
      )
      expect(outcomes[0]!.result.status).toBe('failed')
      expect(outcomes[0]!.result.detail).toContain('platform is down')
      expect(outcomes[1]!.result.status).toBe('created')
    } finally {
      Object.assign(PUBLISHERS, custom)
    }
  })

  it('treats a missing secret as skip, never as fail (decision 8)', async () => {
    const needy: Publisher = {
      name: 'needy',
      missingEnv: () => ['SOME_TOKEN'],
      createDraft: async () => {
        throw new Error('must not be reached')
      },
      updateDraft: async () => {},
    }
    const original = PUBLISHERS.notion
    try {
      ;(PUBLISHERS as Record<string, unknown>).notion = () => needy
      const t = target({ platform: 'notion', notion: { dataSourceRef: 'X' } })
      const [outcome] = await publishAll([{ target: t, resolved: t, article: article() }], { ctx })
      expect(outcome!.result.status).toBe('skipped')
      expect(outcome!.result.detail).toContain('SOME_TOKEN')
    } finally {
      ;(PUBLISHERS as Record<string, unknown>).notion = original
    }
  })

  it('skips a target disabled in config without asking the platform anything', async () => {
    const t = target({ enabled: false })
    const [outcome] = await publishAll([{ target: t, resolved: t, article: article() }], { ctx })
    expect(outcome!.result.status).toBe('skipped')
    expect(outcome!.result.detail).toBe('disabled in config')
  })
})

describe('publish/run — target routing', () => {
  it('matches wildcard and exact schedule lists, and honours enabled', () => {
    const cfg = config()
    expect(targetsFor(cfg, 'daily').map((t) => t.id)).toEqual(['out'])
    expect(targetsFor(cfg, 'weekly').map((t) => t.id)).toEqual(['weekly-only'])
    // `--targets` is an explicit override, so it can name a disabled target on purpose.
    expect(targetsFor(cfg, 'weekly', ['off']).map((t) => t.id)).toEqual(['off'])
  })
})

describe('publish/run — end to end over a memory archive', () => {
  const fs = () =>
    memoryFs({
      'archive/2026/08/2026-08-22.morning.json': record('2026-08-22', 'morning', [
        item({ id: 't1', section: 'tech', rankScore: 0.9 }),
        item({ id: 'n1', section: 'news', rankScore: 9 }),
      ]),
      'archive/2026/08/2026-08-22.evening.json': record('2026-08-22', 'evening', [
        item({ id: 't2', section: 'tech', rankScore: 0.8 }),
      ]),
    })

  const run = (over: Partial<Parameters<typeof runPublish>[0]> = {}) =>
    runPublish({
      config: config(),
      env: { GITHUB_REPOSITORY: 'MashyGGG/daily-brief' },
      now: new Date('2026-08-22T01:30:00.000Z'),
      ctx,
      scheduleId: 'daily',
      date: '2026-08-22',
      catchUp: 0,
      ...over,
    })

  // The 2026-08-27 daily line (21:30 CST) was dispatched at 07:00 the next morning. Dating
  // the publication by the run would have published 08-28, a day with no archive yet.
  it('publishes the day its cron was due, not the day it was dispatched', async () => {
    const store = fs()
    const result = await run({
      fs: store,
      date: undefined,
      now: new Date('2026-08-22T23:00:00.000Z'),
      scheduledAt: new Date('2026-08-22T13:30:00.000Z'),
    })

    expect(result.days.map((d) => d.publishDate)).toEqual(['2026-08-22'])
  })

  it('without the anchor the same run publishes the wrong day', async () => {
    const store = fs()
    const result = await run({
      fs: store,
      date: undefined,
      now: new Date('2026-08-22T23:00:00.000Z'),
    })

    expect(result.days.map((d) => d.publishDate)).toEqual(['2026-08-23'])
  })

  it('publishes once and writes the state', async () => {
    const store = fs()
    const result = await run({ fs: store })
    expect(result.exitCode).toBe(0)
    expect(result.days[0]!.results.map((r) => r.status)).toEqual(['created'])
    expect(result.stateChanged).toBe(true)

    const state = readState('archive', '2026-08-22', store)!
    expect(state.lines.daily!.itemIds).toEqual(['t1', 't2'])
    expect(state.lines.daily!.targets.out!.status).toBe('draft')
  })

  it('is a no-op the second time — the whole point of contentHash', async () => {
    const store = fs()
    await run({ fs: store })
    const before = store.readFile(statePath('archive', '2026-08-22'))

    const again = await run({ fs: store })
    expect(again.days[0]!.results.map((r) => r.status)).toEqual([])
    expect(again.stateChanged).toBe(false)
    expect(store.readFile(statePath('archive', '2026-08-22'))).toBe(before)
  })

  it('writes nothing at all under --dry-run', async () => {
    const store = fs()
    const result = await run({ fs: store, dryRun: true })
    expect(result.days[0]!.results[0]!.status).toBe('created')
    expect(store.readFile(statePath('archive', '2026-08-22'))).toBeNull()
    expect(result.stateChanged).toBe(false)
  })

  it('exits 0 with a warning when the archive is not there yet (§8)', async () => {
    const result = await run({ fs: memoryFs() })
    expect(result.exitCode).toBe(0)
    expect(result.days[0]!.collect.reason).toBe('no-archive')
    expect(result.warnings[0]).toMatch(/catchUpDays/)
  })

  it('catches up over the configured window, oldest day first', async () => {
    const store = memoryFs({
      'archive/2026/08/2026-08-21.morning.json': record('2026-08-21', 'morning', [
        item({ id: 'y1', section: 'tech', rankScore: 0.9 }),
      ]),
      'archive/2026/08/2026-08-22.morning.json': record('2026-08-22', 'morning', [
        item({ id: 't1', section: 'tech', rankScore: 0.9 }),
      ]),
    })
    const result = await run({ fs: store, catchUp: 1 })
    expect(result.days.map((d) => d.publishDate)).toEqual(['2026-08-21', '2026-08-22'])
    expect(result.days.every((d) => d.results[0]!.status === 'created')).toBe(true)
  })

  it('does not let one day steal the other day items via publishedItemIds', async () => {
    const store = memoryFs({
      'archive/2026/08/2026-08-21.morning.json': record('2026-08-21', 'morning', [
        item({ id: 'y1', section: 'tech', rankScore: 0.9 }),
      ]),
      'archive/2026/08/2026-08-22.morning.json': record('2026-08-22', 'morning', [
        item({ id: 't1', section: 'tech', rankScore: 0.9 }),
      ]),
    })
    await run({ fs: store, catchUp: 1 })
    expect(readState('archive', '2026-08-21', store)!.lines.daily!.itemIds).toEqual(['y1'])
    expect(readState('archive', '2026-08-22', store)!.lines.daily!.itemIds).toEqual(['t1'])
  })

  it('reverse-looks-up the line from the firing cron', async () => {
    const result = await run({ fs: fs(), scheduleId: undefined, cron: '30 1 * * *' })
    expect(result.schedule.id).toBe('daily')
  })

  it('rejects a cron no publish schedule generates', async () => {
    await expect(run({ fs: fs(), scheduleId: undefined, cron: '5 5 * * *' })).rejects.toThrow(
      /publish:schedule/,
    )
  })
})

describe('publish/cli', () => {
  it('parses the flags the workflow passes', () => {
    const args = parsePublishArgs([
      '--schedule',
      'weekly',
      '--date',
      '2026-08-24',
      '--targets',
      'a, b',
      '--dry-run',
      '--force',
      '--publish',
      '--explain',
    ])
    expect(args).toMatchObject({
      schedule: 'weekly',
      date: '2026-08-24',
      targets: ['a', 'b'],
      dryRun: true,
      force: true,
      publish: true,
      explain: true,
    })
  })

  it('rejects a malformed date rather than silently publishing today', () => {
    expect(() => parsePublishArgs(['--date', '24/08/2026'])).toThrow(/YYYY-MM-DD/)
  })

  it('rejects naming the line twice', () => {
    expect(() => parsePublishArgs(['--schedule', 'daily', '--cron', '30 1 * * *'])).toThrow(
      /pass one/,
    )
  })

  it('ignores a non-flag argument, as an empty --cron "" from a manual dispatch produces', () => {
    expect(() => parsePublishArgs([''])).not.toThrow()
    expect(() => parsePublishArgs(['--nope'])).toThrow(/unknown option/)
  })

  it('accepts --catch-up 0 as "only this date"', () => {
    expect(parsePublishArgs(['--catch-up', '0']).catchUp).toBe(0)
    expect(() => parsePublishArgs(['--catch-up', '-1'])).toThrow(/non-negative/)
  })
})
