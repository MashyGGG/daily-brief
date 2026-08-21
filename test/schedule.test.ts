import { describe, expect, it } from 'vitest'
import {
  applyScheduleBlock,
  findScheduleByCron,
  findScheduleById,
  generateCrons,
  hasDst,
  localTimeToUtcCron,
  renderScheduleBlock,
  ScheduleError,
  tzOffsetMinutes,
} from '../src/schedule/cron'
import { parseConfig } from '../src/config/schema'
import { configYaml } from './helpers'

const config = (head: string) => parseConfig(configYaml({ head }), {})

const SHANGHAI_0800 = `timezone: Asia/Shanghai
schedules:
  - id: morning
    time: '08:00'
`

describe('timezone offsets', () => {
  it('reads a fixed-offset zone', () => {
    expect(tzOffsetMinutes('Asia/Shanghai', new Date('2026-08-20T00:00:00Z'))).toBe(480)
  })

  it('reads UTC as zero', () => {
    expect(tzOffsetMinutes('UTC', new Date('2026-08-20T00:00:00Z'))).toBe(0)
  })

  it('reads a half-hour offset', () => {
    expect(tzOffsetMinutes('Asia/Kolkata', new Date('2026-08-20T00:00:00Z'))).toBe(330)
  })

  it('reads a negative offset', () => {
    expect(tzOffsetMinutes('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(-300)
  })

  it('rejects a zone that does not exist', () => {
    expect(() => tzOffsetMinutes('Mars/Olympus', new Date())).toThrow(ScheduleError)
  })
})

describe('A17 — local time to UTC cron', () => {
  it('08:00 Asia/Shanghai becomes 00:00 UTC', () => {
    expect(localTimeToUtcCron('08:00', 'Asia/Shanghai').cron).toBe('0 0 * * *')
  })

  it('20:00 Asia/Shanghai becomes 12:00 UTC', () => {
    expect(localTimeToUtcCron('20:00', 'Asia/Shanghai').cron).toBe('0 12 * * *')
  })

  it('handles a non-zero minute', () => {
    expect(localTimeToUtcCron('08:30', 'Asia/Shanghai').cron).toBe('30 0 * * *')
  })

  it('wraps backwards across the date line at 00:30', () => {
    const parts = localTimeToUtcCron('00:30', 'Asia/Shanghai')
    expect(parts.cron).toBe('30 16 * * *')
    expect(parts.dayShift).toBe(-1)
  })

  it('wraps forwards across the date line at 23:30 in a western zone', () => {
    const parts = localTimeToUtcCron('23:30', 'America/New_York', new Date('2026-01-15T12:00:00Z'))
    expect(parts.cron).toBe('30 4 * * *')
    expect(parts.dayShift).toBe(1)
  })

  it('is the identity in UTC', () => {
    expect(localTimeToUtcCron('08:00', 'UTC').cron).toBe('0 8 * * *')
  })

  it('handles a half-hour zone', () => {
    expect(localTimeToUtcCron('08:00', 'Asia/Kolkata').cron).toBe('30 2 * * *')
  })

  it('rejects a malformed time', () => {
    expect(() => localTimeToUtcCron('8:00', 'UTC')).toThrow(ScheduleError)
    expect(() => localTimeToUtcCron('24:00', 'UTC')).toThrow(ScheduleError)
  })
})

describe('DST detection', () => {
  it('reports Asia/Shanghai as DST-free', () => {
    expect(hasDst('Asia/Shanghai')).toBe(false)
  })

  it('flags Europe/London', () => {
    expect(hasDst('Europe/London')).toBe(true)
  })

  it('flags America/New_York', () => {
    expect(hasDst('America/New_York')).toBe(true)
  })

  it('annotates the generated comment with the DST warning', () => {
    const cfg = config(`timezone: Europe/London
schedules:
  - id: morning
    time: '08:00'
`)
    expect(generateCrons(cfg)[0]!.comment).toMatch(/DST/)
  })
})

describe('A19 — reverse lookup from github.event.schedule', () => {
  const twoSlots = config(`timezone: Asia/Shanghai
schedules:
  - id: morning
    time: '08:00'
  - id: evening
    time: '20:00'
`)

  it('finds the schedule that generated the firing cron', () => {
    expect(findScheduleByCron(twoSlots, '0 0 * * *').id).toBe('morning')
    expect(findScheduleByCron(twoSlots, '0 12 * * *').id).toBe('evening')
  })

  it('tolerates extra whitespace', () => {
    expect(findScheduleByCron(twoSlots, '  0   12 * * *  ').id).toBe('evening')
  })

  it('A19 — throws on an unknown cron instead of guessing a default', () => {
    expect(() => findScheduleByCron(twoSlots, '15 7 * * *')).toThrow(ScheduleError)
    expect(() => findScheduleByCron(twoSlots, '15 7 * * *')).toThrow(/out of sync/)
  })

  it('ignores a disabled schedule', () => {
    const cfg = config(`timezone: Asia/Shanghai
schedules:
  - id: morning
    time: '08:00'
  - id: evening
    time: '20:00'
    enabled: false
`)
    expect(() => findScheduleByCron(cfg, '0 12 * * *')).toThrow(ScheduleError)
  })

  it('refuses an ambiguous cron rather than picking one', () => {
    const cfg = config(`timezone: Asia/Shanghai
schedules:
  - id: a
    time: '08:00'
  - id: b
    time: '08:00'
`)
    expect(() => findScheduleByCron(cfg, '0 0 * * *')).toThrow(/ambiguous/)
  })

  it('findScheduleById names the known ids when it misses', () => {
    expect(() => findScheduleById(twoSlots, 'lunch')).toThrow(/morning, evening/)
  })
})

describe('workflow generation', () => {
  const WORKFLOW = `name: daily-brief

on:
  schedule:
    # BEGIN generated schedule
    - cron: '0 0 * * *' # stale
    # END generated schedule
  workflow_dispatch:
`

  it('renders an enabled cron and comments out a disabled one', () => {
    const cfg = config(`timezone: Asia/Shanghai
schedules:
  - id: morning
    time: '08:00'
  - id: evening
    time: '20:00'
    enabled: false
`)
    const block = renderScheduleBlock(cfg)
    expect(block).toContain(`- cron: '0 0 * * *' # morning`)
    expect(block).toContain(`# - cron: '0 12 * * *' # evening`)
    expect(block).toContain('do not hand-edit')
  })

  it('A17 — rewrites only the marked region', () => {
    const cfg = config(`timezone: Asia/Shanghai
schedules:
  - id: morning
    time: '09:15'
`)
    const out = applyScheduleBlock(WORKFLOW, cfg)
    expect(out).toContain(`- cron: '15 1 * * *'`)
    expect(out).not.toContain('# stale')
    expect(out).toContain('name: daily-brief')
    expect(out).toContain('workflow_dispatch:')
  })

  it('A17 — regenerating an in-sync workflow is a no-op', () => {
    const cfg = config(SHANGHAI_0800)
    const once = applyScheduleBlock(WORKFLOW, cfg)
    expect(applyScheduleBlock(once, cfg)).toBe(once)
  })

  it('A17 — a config change makes the generated output differ (which is what check:schedule sees)', () => {
    const before = applyScheduleBlock(WORKFLOW, config(SHANGHAI_0800))
    const after = applyScheduleBlock(
      WORKFLOW,
      config(`timezone: Asia/Shanghai
schedules:
  - id: morning
    time: '07:00'
`),
    )
    expect(before).not.toBe(after)
  })

  it('preserves the surrounding indentation', () => {
    const out = applyScheduleBlock(WORKFLOW, config(SHANGHAI_0800))
    expect(out).toMatch(/\n {4}- cron: '0 0 \* \* \*'/)
  })

  it('refuses to guess when the markers are missing', () => {
    expect(() => applyScheduleBlock('name: x\non:\n  schedule:\n', config(SHANGHAI_0800))).toThrow(
      /markers/,
    )
  })

  it('says so when every schedule is disabled', () => {
    const cfg = config(`timezone: Asia/Shanghai
schedules:
  - id: morning
    time: '08:00'
    enabled: false
`)
    expect(renderScheduleBlock(cfg)).toContain('no enabled schedules')
  })
})

describe('the committed workflow matches the committed config', () => {
  it('A17 — check:schedule would pass on a fresh checkout', async () => {
    const { readFileSync } = await import('node:fs')
    const { loadConfig } = await import('../src/config/load')
    const workflow = readFileSync('.github/workflows/daily-brief.yml', 'utf8')
    const { config: cfg } = loadConfig('brief.config.yaml', {})
    expect(applyScheduleBlock(workflow, cfg)).toBe(workflow)
  })
})

describe('M0 — the trigger moved to 07:10 to absorb the LLM stages', () => {
  it('07:10 Asia/Shanghai runs at 23:10 UTC on the previous day', () => {
    const parts = localTimeToUtcCron('07:10', 'Asia/Shanghai')
    expect(parts.cron).toBe('10 23 * * *')
    expect(parts.dayShift).toBe(-1)
  })

  it('lands on a minute that is neither :00 nor :30 — those are the crowded ones', () => {
    const minute = Number(localTimeToUtcCron('07:10', 'Asia/Shanghai').cron.split(' ')[0])
    expect(minute % 30).not.toBe(0)
  })

  it('still reverse-looks-up the schedule from the cron GitHub reports', () => {
    const cfg = config(`timezone: Asia/Shanghai
schedules:
  - id: morning
    time: '07:10'
`)
    expect(findScheduleByCron(cfg, '10 23 * * *').id).toBe('morning')
  })
})
