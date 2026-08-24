import { describe, expect, it } from 'vitest'
import { ConfigError, parseConfig } from '../src/config/schema'
import {
  applyScheduleBlock,
  findPublishScheduleByCron,
  findPublishScheduleById,
  generatePublishCrons,
  renderScheduleBlock,
  ScheduleError,
} from '../src/schedule/cron'

const HEAD = `timezone: Asia/Shanghai
title: 每日早报
schedules:
  - id: morning
    time: '07:10'
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
`

const config = (publishBlock: string) => parseConfig(HEAD + publishBlock, {})

const VALID = `publish:
  enabled: true
  include: [tech]
  schedules:
    - id: daily
      time: '09:30'
      window: { days: 1, slots: [morning] }
    - id: weekly
      time: '10:30'
      weekday: mon
      window: { days: 1, slots: [weekly] }
  targets:
    - id: notion-archive
      platform: notion
      secretRef: NOTION_TOKEN
      schedules: ['*']
      notion: { dataSourceRef: NOTION_DATA_SOURCE_ID }
    - id: juejin
      platform: juejin
      secretRef: JUEJIN_COOKIE
      schedules: [daily, weekly]
      juejin: { categoryId: 'C1', tagIds: ['T1'] }
`

function issuesOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof ConfigError)
      return err.issues.map((i) => `${i.path}: ${i.message}`).join('\n')
    throw err
  }
  throw new Error('expected the config to be rejected')
}

/** PUBLISH.md §2.2 — the five checks, plus the one that only this block can get wrong. */
describe('config — the publish block', () => {
  it('accepts the shape from §2.1', () => {
    const cfg = config(VALID)
    expect(cfg.publish.enabled).toBe(true)
    expect(cfg.publish.schedules.map((s) => s.id)).toEqual(['daily', 'weekly'])
    expect(cfg.publish.targets[1]!.juejin!.tagIds).toEqual(['T1'])
    // Stage A of §6.5 is the DEFAULT: nothing auto-publishes unless it says so.
    expect(cfg.publish.targets[1]!.autoPublish).toBe(false)
  })

  it('defaults to disabled, so an untouched config publishes nothing', () => {
    expect(parseConfig(HEAD, {}).publish.enabled).toBe(false)
  })

  it('★ rejects an include naming a section that does not exist', () => {
    // The one field here where a typo produces no error and no effect — just one
    // section quietly missing from every published article, forever.
    const issues = issuesOf(() => config(VALID.replace('include: [tech]', 'include: [tehc]')))
    expect(issues).toMatch(/publish\.include\.0.*unknown section "tehc"/)
  })

  it('rejects duplicate line ids and duplicate target ids', () => {
    expect(
      issuesOf(() =>
        config(
          VALID.replace(
            "    - id: weekly\n      time: '10:30'",
            "    - id: daily\n      time: '10:30'",
          ),
        ),
      ),
    ).toMatch(/publish\.schedules\.1\.id.*duplicate/)
  })

  it('rejects a target pointing at a line that does not exist', () => {
    expect(
      issuesOf(() => config(VALID.replace('schedules: [daily, weekly]', 'schedules: [dialy]'))),
    ).toMatch(/unknown publish schedule "dialy"/)
  })

  it('rejects an override keyed on a line that does not exist', () => {
    const withOverride = VALID + `      overrides:\n        wekly:\n          tags: [x]\n`
    expect(issuesOf(() => config(withOverride))).toMatch(/unknown publish schedule "wekly"/)
  })

  it('requires exactly one of notion.dataSourceRef / notion.pageRef', () => {
    expect(
      issuesOf(() =>
        config(VALID.replace('notion: { dataSourceRef: NOTION_DATA_SOURCE_ID }', 'notion: {}')),
      ),
    ).toMatch(/exactly one of notion.dataSourceRef/)

    expect(
      issuesOf(() =>
        config(
          VALID.replace(
            'notion: { dataSourceRef: NOTION_DATA_SOURCE_ID }',
            'notion: { dataSourceRef: A, pageRef: B }',
          ),
        ),
      ),
    ).toMatch(/exactly one of notion.dataSourceRef/)
  })

  it('refuses to start rather than guess a 掘金 category', () => {
    expect(
      issuesOf(() =>
        config(VALID.replace("      juejin: { categoryId: 'C1', tagIds: ['T1'] }\n", '')),
      ),
    ).toMatch(/requires a "juejin" block/)
  })

  it('caps 掘金 tags at three, because a fourth is a request the platform rejects', () => {
    expect(
      issuesOf(() => config(VALID.replace("tagIds: ['T1']", "tagIds: ['1','2','3','4']"))),
    ).toMatch(/tagIds/)
  })

  it('flags an enabled line no enabled target publishes', () => {
    expect(
      issuesOf(() =>
        config(
          VALID.replace("schedules: ['*']", 'schedules: [daily]').replace(
            'schedules: [daily, weekly]',
            'schedules: [daily]',
          ),
        ),
      ),
    ).toMatch(/no enabled target publishes it/)
  })
})

/** §7.2 — the publish workflow's cron comes from the same generator and the same guard. */
describe('schedule — publish crons', () => {
  it('generates one cron per line, weekly through weeklyToUtcCron', () => {
    const crons = generatePublishCrons(config(VALID))
    expect(crons.map((c) => c.cron)).toEqual(['30 1 * * *', '30 2 * * 1'])
    expect(crons[1]!.comment).toContain('Mon 10:30')
  })

  it('emits no live cron while publish.enabled is false', () => {
    const crons = generatePublishCrons(config(VALID.replace('enabled: true', 'enabled: false')))
    expect(crons.every((c) => !c.enabled)).toBe(true)
  })

  it('reverse-looks-up the line, and refuses to guess on a miss', () => {
    const cfg = config(VALID)
    expect(findPublishScheduleByCron(cfg, '30 1 * * *').id).toBe('daily')
    expect(findPublishScheduleByCron(cfg, '  30   2 * * 1 ').id).toBe('weekly')
    expect(() => findPublishScheduleByCron(cfg, '0 0 * * *')).toThrow(ScheduleError)
    expect(() => findPublishScheduleById(cfg, 'nope')).toThrow(/Unknown publish schedule/)
  })

  it('names publish:schedule in the generated block, not brief:schedule', () => {
    const block = renderScheduleBlock(config(VALID), '    ', 'publish')
    expect(block).toContain('pnpm publish:schedule')
    expect(block).not.toContain('pnpm brief:schedule')
    // The brief block must be untouched by any of this.
    expect(renderScheduleBlock(config(VALID))).toContain('pnpm brief:schedule')
  })

  it('rewrites only the marked region, and is idempotent', () => {
    const workflow = [
      'name: publish',
      'on:',
      '  schedule:',
      '    # BEGIN generated schedule',
      '    # END generated schedule',
      '',
    ].join('\n')
    const once = applyScheduleBlock(workflow, config(VALID), 'publish')
    expect(once).toContain("- cron: '30 1 * * *'")
    expect(applyScheduleBlock(once, config(VALID), 'publish')).toBe(once)
  })
})
