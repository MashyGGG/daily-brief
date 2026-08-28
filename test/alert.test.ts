import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeAlert, failedEdition } from '../src/alert/compose'
import { ConfigError } from '../src/config/schema'
import type { loadConfig } from '../src/config/load'

/**
 * These run against the REAL brief.config.yaml on purpose: the whole point of the change
 * is that the alert resolves a live cron the same way the brief step does, and a fixture
 * config would not catch the two drifting apart.
 */
const base = {
  GITHUB_REPOSITORY: 'MashyGGG/daily-brief',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '42',
  ALERT_REASON: 'workflow daily-brief failed at job brief',
} as NodeJS.ProcessEnv

afterEach(() => {
  vi.useRealTimers()
})

/** Dispatched 2026-08-28 06:54 UTC — the real 7h44m-late morning run. */
function freeze(iso = '2026-08-28T06:54:00.000Z') {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso))
}

describe('the failure alert names the edition that failed', () => {
  // Frozen at 2026-08-28 06:54 UTC = 14:54 CST. The two 23:xx UTC crons last fired the
  // night before, which is 2026-08-28 in CST; the two daytime crons last fired on the
  // 27th CST. The dates below differ for that reason, and that is the behaviour worth
  // pinning — the alert names the edition the run belonged to, not "today".
  it.each([
    ['10 23 * * *', '早报', '2026-08-28'],
    ['40 23 * * *', '早间要闻', '2026-08-28'],
    ['10 11 * * *', '晚间要闻', '2026-08-27'],
    ['10 12 * * *', '晚报', '2026-08-27'],
  ])('cron %s → %s %s', (cron, label, date) => {
    freeze()
    const { subject } = composeAlert({ ...base, ALERT_CRON: cron })
    expect(subject).toBe(`[daily-brief] ${label} 失败 · ${date}`)
  })

  it('gives the weekly its configured title, not its slot label', () => {
    freeze('2026-08-31T02:00:00.000Z') // Monday, after `20 0 * * 1` fired
    expect(composeAlert({ ...base, ALERT_CRON: '20 0 * * 1' }).subject).toBe(
      '[daily-brief] 每周回顾 失败 · 2026-08-31',
    )
  })

  it('dates the alert by the cron that was due, not by a late dispatch', () => {
    // 2026-08-28 06:13 CST is 2026-08-27 22:13 UTC: the evening cron (12:10 UTC) that
    // fired on the 27th. The alert must name the 27th, like the issue would have.
    freeze('2026-08-27T22:13:43.000Z')
    expect(failedEdition({ ...base, ALERT_CRON: '10 12 * * *' })).toEqual({
      label: '晚报',
      date: '2026-08-27',
    })
  })

  it('reads a manual run from its schedule input', () => {
    freeze()
    expect(composeAlert({ ...base, ALERT_SCHEDULE: 'news-pm' }).subject).toBe(
      '[daily-brief] 晚间要闻 失败 · 2026-08-28',
    )
  })
})

describe('the alert still goes out when the edition cannot be known', () => {
  // Every one of these used to be the ONLY wording, so the fallback is the old behaviour.
  const explodes = (() => {
    throw new ConfigError('brief.config.yaml: sources[3].weight must be a number')
  }) as typeof loadConfig

  it.each([
    ['neither input set', {}, undefined],
    ['a cron no schedule generates', { ALERT_CRON: '5 4 * * *' }, undefined],
    ['an unknown schedule id', { ALERT_SCHEDULE: 'noon' }, undefined],
    // The alert exists to report failures, and a config that will not parse is one of
    // them: resolving the edition must never be what stops the alert going out.
    ['a config that will not load', { ALERT_CRON: '10 23 * * *' }, explodes],
  ])('%s', (_name, extra, load) => {
    const { subject, content } = composeAlert({ ...base, ...extra } as NodeJS.ProcessEnv, load)
    expect(subject).toBe('[daily-brief] 今日早报失败')
    expect(content).toContain('⚠️ 今日早报失败')
    expect(content).toContain(
      '日志：[查看运行](https://github.com/MashyGGG/daily-brief/actions/runs/42)',
    )
  })
})

describe('the alert body', () => {
  it('redacts a secret that leaked into the reason', () => {
    const env = { ...base, ALERT_REASON: 'SMTP said hunter2 is wrong', SMTP_PASS: 'hunter2' }
    expect(composeAlert(env).content).not.toContain('hunter2')
  })

  it('says "(local run)" when there is no Actions run to link', () => {
    const env = { ...base }
    delete env.GITHUB_SERVER_URL
    delete env.GITHUB_RUN_ID
    expect(composeAlert(env).content).toContain('日志：[查看运行]((local run))')
  })
})
