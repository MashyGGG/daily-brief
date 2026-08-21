import { describe, expect, it } from 'vitest'
import { parseConfig, type BriefConfig, type Item } from '../src/config/schema'
import { memoryFs } from '../src/archive/fs'
import type { ArchiveRecord } from '../src/archive/read'
import { collectWeekly, describeWindow, weeklySchedule } from '../src/core/weekly'
import { run } from '../src/core/pipeline'
import { weeklyToUtcCron, generateCrons, findRunByCron } from '../src/schedule/cron'
import { parseArgs } from '../src/cli'
import { renderRunSummary } from '../src/summary'
import type { ChannelContext, HttpFetch } from '../src/channels'
import { configYaml, item } from './helpers'

/**
 * §9 M3 — the weekly review. The property every test here is really asserting: it reads
 * the archive and nothing else. No feed is fetched, no model is called for an item, and
 * nothing is written back.
 */

const WEEKLY_YAML = (weekly: string) =>
  configYaml({
    recipients: `recipients:
  - id: me-mail
    channel: email
    driver: smtp
    to: me@example.com
    sections: ['*']
    format: html
${weekly}`,
  })

const config = (weekly = '') =>
  parseConfig(
    WEEKLY_YAML(
      weekly ||
        `weekly:
  enabled: true
  recipients: [me-mail]
`,
    ),
    {},
  )

/** An archived issue on `date` holding `items`. */
function archived(date: string, items: Item[], digest?: string): string {
  const record: ArchiveRecord = {
    date,
    slot: null,
    scheduleId: 'morning',
    generatedAt: `${date}T00:00:00.000Z`,
    configHash: 'hash',
    timezone: 'Asia/Shanghai',
    lookbackHours: 24,
    itemCount: items.length,
    items,
    ...(digest
      ? {
          digest: {
            text: digest,
            meta: {
              by: 'llm' as const,
              model: 'm',
              promptVersion: '1',
              inputKind: 'summaries' as const,
            },
          },
        }
      : {}),
    warnings: [],
  }
  return JSON.stringify(record)
}

function archiveOf(days: Record<string, Item[]>): Record<string, string> {
  const files: Record<string, string> = {}
  for (const [date, items] of Object.entries(days)) {
    const [year, month] = date.split('-')
    files[`archive/${year}/${month}/${date}.json`] = archived(date, items)
  }
  return files
}

describe('collectWeekly — the week, out of the archive', () => {
  it('reads `days` back from the end date, inclusive', () => {
    const fs = memoryFs(
      archiveOf({
        '2026-08-20': [item({ id: 'a', section: 'tech', rankScore: 0.9 })],
        '2026-08-14': [item({ id: 'b', section: 'tech', rankScore: 0.8 })],
        // 8 days back — outside a 7-day window ending on the 20th.
        '2026-08-13': [item({ id: 'c', section: 'tech', rankScore: 1 })],
      }),
    )
    const { sections, window } = collectWeekly(config(), '2026-08-20', ['*'], fs)
    expect(window).toMatchObject({ from: '2026-08-14', to: '2026-08-20', issues: 2, collected: 2 })
    expect(sections[0]!.items.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('re-ranks by the score the daily run already computed, newest first on a tie', () => {
    const fs = memoryFs(
      archiveOf({
        '2026-08-20': [
          item({ id: 'low', section: 'tech', rankScore: 0.1 }),
          item({
            id: 'tie-old',
            section: 'tech',
            rankScore: 0.5,
            publishedAt: '2026-08-15T00:00:00.000Z',
          }),
        ],
        '2026-08-19': [
          item({ id: 'high', section: 'tech', rankScore: 0.9 }),
          item({
            id: 'tie-new',
            section: 'tech',
            rankScore: 0.5,
            publishedAt: '2026-08-18T00:00:00.000Z',
          }),
        ],
      }),
    )
    const { sections } = collectWeekly(config(), '2026-08-20', ['*'], fs)
    expect(sections[0]!.items.map((i) => i.id)).toEqual(['high', 'tie-new', 'tie-old', 'low'])
  })

  it('caps each section at limitPerSection', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      item({ id: `i${i}`, section: 'tech', rankScore: 1 - i / 10 }),
    )
    const fs = memoryFs(archiveOf({ '2026-08-20': many }))
    const cfg = config(`weekly:
  enabled: true
  recipients: [me-mail]
  limitPerSection: 3
`)
    const { sections, window } = collectWeekly(cfg, '2026-08-20', ['*'], fs)
    expect(sections[0]!.items.map((i) => i.id)).toEqual(['i0', 'i1', 'i2'])
    // The cap is on what is shown, not on what was read — the window still reports 9.
    expect(window.collected).toBe(9)
  })

  it('drops an item seen twice — a re-sent issue must not double the review', () => {
    const shared = item({ id: 'same', section: 'tech', rankScore: 0.5 })
    const fs = memoryFs(archiveOf({ '2026-08-20': [shared], '2026-08-19': [shared] }))
    const { sections, window } = collectWeekly(config(), '2026-08-20', ['*'], fs)
    expect(sections[0]!.items).toHaveLength(1)
    expect(window.issues).toBe(2)
  })

  it('an item whose section is gone (retired, or not requested) is skipped, not crashed on', () => {
    const fs = memoryFs(
      archiveOf({
        '2026-08-20': [
          item({ id: 'a', section: 'tech' }),
          item({ id: 'b', section: 'releases' }),
          item({ id: 'c', section: 'news' }),
        ],
      }),
    )
    const { sections } = collectWeekly(config(), '2026-08-20', ['tech'], fs)
    expect(sections.map((s) => s.id)).toEqual(['tech'])
    expect(sections[0]!.items.map((i) => i.id)).toEqual(['a'])
  })

  it('an empty archive is an empty week, not an error', () => {
    const { sections, window } = collectWeekly(config(), '2026-08-20', ['*'], memoryFs())
    expect(sections).toEqual([])
    expect(window).toMatchObject({ issues: 0, collected: 0 })
  })

  it('a corrupt file is skipped, exactly as elsewhere in the archive layer', () => {
    const fs = memoryFs({
      ...archiveOf({ '2026-08-20': [item({ id: 'a', section: 'tech' })] }),
      'archive/2026/08/2026-08-19.json': '{ not json',
    })
    const { window } = collectWeekly(config(), '2026-08-20', ['*'], fs)
    expect(window.issues).toBe(1)
  })

  it('describeWindow says what was read', () => {
    expect(
      describeWindow({ from: '2026-08-14', to: '2026-08-20', issues: 6, collected: 110 }),
    ).toBe('2026-08-14 → 2026-08-20 · 6 期归档 · 收集 110 条')
  })
})

describe('the weekly cron', () => {
  it('Mon 08:00 Asia/Shanghai is 00:00 UTC the same day', () => {
    const parts = weeklyToUtcCron('08:00', 1, 'Asia/Shanghai')
    expect(parts.cron).toBe('0 0 * * 1')
    expect(parts.dayShift).toBe(0)
  })

  it('a time that crosses back over UTC midnight moves the weekday with it', () => {
    // 07:10 Monday CST = 23:10 Sunday UTC. A cron still saying Monday would be a day late.
    const parts = weeklyToUtcCron('07:10', 1, 'Asia/Shanghai')
    expect(parts.cron).toBe('10 23 * * 0')
    expect(parts.dayShift).toBe(-1)
  })

  it('Sunday is ISO 7 locally and 0 in cron', () => {
    expect(weeklyToUtcCron('12:00', 7, 'UTC').cron).toBe('0 12 * * 0')
  })

  it('is generated alongside the daily crons and flagged as the weekly', () => {
    const crons = generateCrons(config())
    expect(crons.map((c) => [c.cron, c.weekly])).toEqual([
      ['0 0 * * *', false],
      ['0 0 * * 1', true],
    ])
    expect(crons[1]!.comment).toContain('weekly - Mon 08:00 Asia/Shanghai')
  })

  it('a disabled weekly still generates (commented out), and cannot be fired', () => {
    const cfg = config(`weekly:
  enabled: false
`)
    expect(generateCrons(cfg).find((c) => c.weekly)!.enabled).toBe(false)
    expect(() => findRunByCron(cfg, '0 0 * * 1')).toThrow(/No enabled schedule/)
  })

  it('the firing cron is what tells a weekly run apart from a daily one', () => {
    expect(findRunByCron(config(), '0 0 * * 1')).toMatchObject({ weekly: true })
    expect(findRunByCron(config(), '0 0 * * *')).toMatchObject({ weekly: false })
  })
})

describe('weeklySchedule — derived, not a second place to configure things', () => {
  it('carries the weekly section and recipient lists, and a matching lookback', () => {
    expect(weeklySchedule(config())).toEqual({
      id: 'weekly',
      time: '08:00',
      lookbackHours: 7 * 24,
      sections: ['*'],
      recipients: ['me-mail'],
      enabled: true,
    })
  })
})

describe('--weekly on the command line', () => {
  it('takes an optional end date', () => {
    expect(parseArgs(['--weekly', '2026-08-20'])).toMatchObject({
      weekly: true,
      weeklyEnding: '2026-08-20',
    })
  })

  it('does not swallow the flag behind it', () => {
    const args = parseArgs(['--weekly', '--dry-run'])
    expect(args).toMatchObject({ weekly: true, dryRun: true })
    expect(args.weeklyEnding).toBeUndefined()
  })

  it('refuses to combine with --from-archive', () => {
    expect(() => parseArgs(['--weekly', '--from-archive', '2026-08-20'])).toThrow(/pick one/)
  })
})

describe('a weekly run, end to end', () => {
  const ctx = (): ChannelContext => ({
    env: {
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '465',
      SMTP_USER: 'me@gmail.com',
      SMTP_PASS: 'app-password-1234',
      EMAIL_FROM: 'me@gmail.com',
    },
    fetchImpl: (async () => ({ ok: true, status: 200, text: async () => '{}' })) as HttpFetch,
    sleep: async () => {},
    createMailer: () => ({ sendMail: async () => ({}) }),
  })

  const files = () =>
    archiveOf({
      '2026-08-20': [
        item({ id: 'a', section: 'tech', rankScore: 0.9, summary: '早报那天写好的摘要' }),
        item({ id: 'b', section: 'news', rankScore: 0.4 }),
      ],
      '2026-08-18': [item({ id: 'c', section: 'tech', rankScore: 0.95 })],
    })

  it('fetches nothing, archives nothing, and delivers the week', async () => {
    const fs = memoryFs(files())
    const channelContext = ctx()
    let fetched = 0
    const result = await run({
      config: config(),
      configHash: 'hash',
      now: new Date('2026-08-20T00:30:00.000Z'),
      env: channelContext.env,
      weekly: true,
      dryRun: false,
      fetchImpl: (async () => {
        fetched++
        throw new Error('a weekly must not fetch')
      }) as never,
      channelContext,
      fs,
    })

    expect(fetched).toBe(0)
    expect(result.sources).toEqual([])
    expect(result.archived).toBeNull()
    expect([...fs.files.keys()].some((k) => k.includes('index.md'))).toBe(false)
    expect(result.weekly).toMatchObject({ from: '2026-08-14', to: '2026-08-20', issues: 2 })
    expect(result.brief.title).toBe('每周回顾')
    expect(result.brief.scheduleId).toBe('weekly')
    expect(result.deliveries.map((d) => d.recipient)).toEqual(['me-mail'])
    expect(result.exitCode).toBe(0)
    // The summary the morning run paid for is still the one being shown.
    expect(result.brief.sections[0]!.items[1]!.summary).toBe('早报那天写好的摘要')
  })

  it('honours --weekly <date>, so a missed Monday can be rebuilt', async () => {
    const channelContext = ctx()
    const result = await run({
      config: config(),
      configHash: 'hash',
      now: new Date('2026-08-25T00:30:00.000Z'),
      env: channelContext.env,
      weekly: true,
      weeklyEnding: '2026-08-20',
      dryRun: true,
      fetchImpl: (async () => {
        throw new Error('no fetching')
      }) as never,
      channelContext,
      fs: memoryFs(files()),
    })
    expect(result.brief.date).toBe('2026-08-20')
    expect(result.weekly!.to).toBe('2026-08-20')
  })

  it('an empty window sends nothing rather than an empty review', async () => {
    const channelContext = ctx()
    const result = await run({
      config: config(),
      configHash: 'hash',
      now: new Date('2026-08-20T00:30:00.000Z'),
      env: channelContext.env,
      weekly: true,
      dryRun: false,
      fetchImpl: (async () => {
        throw new Error('no fetching')
      }) as never,
      channelContext,
      fs: memoryFs(),
    })
    expect(result.empty).toBe(true)
    expect(result.deliveries).toEqual([])
    expect(result.exitCode).toBe(0)
  })

  it('the run summary says where the content came from', async () => {
    const channelContext = ctx()
    const result = await run({
      config: config(),
      configHash: 'hash',
      now: new Date('2026-08-20T00:30:00.000Z'),
      env: channelContext.env,
      weekly: true,
      dryRun: true,
      fetchImpl: (async () => {
        throw new Error('no fetching')
      }) as never,
      channelContext,
      fs: memoryFs(files()),
    })
    const summary = renderRunSummary(result, { dryRun: true })
    expect(summary).toContain('周报：2026-08-14 → 2026-08-20 · 2 期归档')
    expect(summary).toContain('零抓取，不归档')
  })
})

describe('weekly config validation', () => {
  it('an enabled weekly with no recipients is a config error, not a quiet no-op', () => {
    expect(() =>
      parseConfig(
        WEEKLY_YAML(`weekly:
  enabled: true
`),
        {},
      ),
    ).toThrow(/weekly.recipients is empty/)
  })

  it('an unknown recipient is caught at load time', () => {
    expect(() =>
      parseConfig(
        WEEKLY_YAML(`weekly:
  enabled: true
  recipients: [nobody]
`),
        {},
      ),
    ).toThrow(/unknown recipient "nobody"/)
  })

  it('is off by default, so an existing config gains no Monday job', () => {
    const cfg: BriefConfig = parseConfig(configYaml(), {})
    expect(cfg.weekly.enabled).toBe(false)
    expect(cfg.weekly.days).toBe(7)
  })
})
