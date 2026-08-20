import { describe, expect, it } from 'vitest'
import { archiveNames, parseArchiveFilename, recentDates, shiftDate } from '../src/archive/paths'
import { memoryFs } from '../src/archive/fs'
import { listAllIssues, readRecentItems, type ArchiveRecord } from '../src/archive/read'
import { writeArchive } from '../src/archive/write'
import { renderIndex } from '../src/render/markdown'
import type { Brief } from '../src/core/brief'
import { item, NOW } from './helpers'

describe('archive paths', () => {
  it('nests by year and month', () => {
    const names = archiveNames('archive', '2026-08-20', null)
    expect(names.markdown).toBe('archive/2026/08/2026-08-20.md')
    expect(names.json).toBe('archive/2026/08/2026-08-20.json')
    expect(names.relativeMarkdown).toBe('2026/08/2026-08-20.md')
  })

  it('adds a slot suffix once more than one schedule is live', () => {
    const names = archiveNames('archive', '2026-08-20', 'evening')
    expect(names.markdown).toBe('archive/2026/08/2026-08-20.evening.md')
  })

  it('crosses a month boundary', () => {
    expect(archiveNames('archive', '2026-09-01', null).dir).toBe('archive/2026/09')
    expect(shiftDate('2026-09-01', -1)).toBe('2026-08-31')
  })

  it('crosses a year boundary', () => {
    expect(archiveNames('archive', '2027-01-01', null).dir).toBe('archive/2027/01')
    expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('handles a leap day', () => {
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29')
  })

  it('lists the recent dates newest first', () => {
    expect(recentDates('2026-08-20', 3)).toEqual(['2026-08-20', '2026-08-19', '2026-08-18'])
  })

  it('rejects a malformed date', () => {
    expect(() => archiveNames('archive', 'nope', null)).toThrow()
  })

  describe('parseArchiveFilename', () => {
    it('parses a plain issue', () => {
      expect(parseArchiveFilename('2026-08-20.json')).toEqual({ date: '2026-08-20', slot: null })
    })
    it('parses a slotted issue', () => {
      expect(parseArchiveFilename('2026-08-20.evening.json')).toEqual({
        date: '2026-08-20',
        slot: 'evening',
      })
    })
    it('ignores the rendered markdown and anything else', () => {
      expect(parseArchiveFilename('2026-08-20.md')).toBeNull()
      expect(parseArchiveFilename('index.md')).toBeNull()
      expect(parseArchiveFilename('notes.json')).toBeNull()
    })
  })
})

function record(date: string, slot: string | null, ids: string[]): string {
  const rec: ArchiveRecord = {
    date,
    slot,
    scheduleId: slot ?? 'morning',
    generatedAt: `${date}T00:30:00.000Z`,
    configHash: 'abc123',
    timezone: 'Asia/Shanghai',
    lookbackHours: 24,
    itemCount: ids.length,
    items: ids.map((id) => item({ id, title: `Title ${id}` })),
    warnings: [],
  }
  return JSON.stringify(rec)
}

describe('reading the archive', () => {
  const fs = memoryFs({
    'archive/2026/08/2026-08-20.json': record('2026-08-20', null, ['a', 'b']),
    'archive/2026/08/2026-08-19.json': record('2026-08-19', null, ['c']),
    'archive/2026/08/2026-08-05.json': record('2026-08-05', null, ['old']),
    'archive/2026/07/2026-07-31.json': record('2026-07-31', null, ['older']),
  })

  it('A7 — collects the items inside the lookback window only', () => {
    const { items } = readRecentItems('archive', '2026-08-20', 3, fs)
    expect(items.map((i) => i.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('reaches back across a month boundary when the window is long enough', () => {
    const { items } = readRecentItems('archive', '2026-08-20', 25, fs)
    expect(items.map((i) => i.id)).toContain('older')
  })

  it('tolerates missing days', () => {
    expect(() => readRecentItems('archive', '2026-08-20', 14, fs)).not.toThrow()
  })

  it('skips a corrupt file instead of failing the run', () => {
    const broken = memoryFs({ 'archive/2026/08/2026-08-20.json': '{not json' })
    expect(readRecentItems('archive', '2026-08-20', 2, broken).items).toEqual([])
  })

  it('lists every issue newest first', () => {
    const entries = listAllIssues('archive', fs)
    expect(entries.map((e) => e.date)).toEqual([
      '2026-08-20',
      '2026-08-19',
      '2026-08-05',
      '2026-07-31',
    ])
    expect(entries[0]!.path).toBe('2026/08/2026-08-20.md')
    expect(entries[0]!.itemCount).toBe(2)
  })
})

describe('index.md rebuild', () => {
  const entry = (date: string) => ({ date, slot: null, path: `p/${date}.md`, itemCount: 3 })

  it('lists everything when there are fewer than `keep` issues', () => {
    const out = renderIndex([entry('2026-08-20'), entry('2026-08-19')], 30, NOW, 'Asia/Shanghai')
    expect(out).toContain('2026-08-20')
    expect(out).toContain('2026-08-19')
    expect(out).toContain('最近 2 期')
  })

  it('truncates to `keep` while reporting the true total', () => {
    const entries = Array.from({ length: 45 }, (_, i) =>
      entry(`2026-07-${String(i + 1).padStart(2, '0')}`),
    )
    const out = renderIndex(entries, 30, NOW, 'Asia/Shanghai')
    const rows = out.split('\n').filter((l) => l.startsWith('| 2026-'))
    expect(rows).toHaveLength(30)
    expect(out).toContain('共 45 期')
  })

  it('shows the slot column when a day has two issues', () => {
    const out = renderIndex(
      [
        { date: '2026-08-20', slot: 'morning', path: 'a.md', itemCount: 8 },
        { date: '2026-08-20', slot: 'evening', path: 'b.md', itemCount: 4 },
      ],
      30,
      NOW,
      'Asia/Shanghai',
    )
    expect(out).toContain('| 2026-08-20 | morning |')
    expect(out).toContain('| 2026-08-20 | evening |')
  })
})

describe('writeArchive', () => {
  const brief: Brief = {
    date: '2026-08-20',
    scheduleId: 'morning',
    slot: null,
    title: '每日早报',
    timezone: 'Asia/Shanghai',
    generatedAt: NOW.toISOString(),
    lookbackHours: 24,
    sections: [{ id: 'tech', title: '国际技术', items: [item({ id: 'x', title: 'Hello' })] }],
    warnings: [],
  }
  const archive = {
    enabled: true,
    dir: 'archive',
    indexKeep: 30,
    commit: true,
    dedupeLookbackDays: 14,
  }

  it('writes the md, the json and the index', () => {
    const fs = memoryFs()
    const result = writeArchive({
      brief,
      archive,
      configHash: 'abc',
      scheduleId: 'morning',
      now: NOW,
      fs,
      secretValues: [],
    })
    expect(fs.files.has(result.markdownPath)).toBe(true)
    expect(fs.files.has(result.jsonPath)).toBe(true)
    expect(fs.files.get(result.indexPath)).toContain('2026-08-20')
    expect(result.record.itemCount).toBe(1)
    expect(result.record.configHash).toBe('abc')
  })

  it('overwrites rather than appends when the same day is re-run', () => {
    const fs = memoryFs()
    const args = {
      brief,
      archive,
      configHash: 'abc',
      scheduleId: 'morning',
      now: NOW,
      fs,
      secretValues: [],
    }
    writeArchive(args)
    writeArchive(args)
    const json = JSON.parse(fs.files.get('archive/2026/08/2026-08-20.json')!) as ArchiveRecord
    expect(json.items).toHaveLength(1)
    expect([...fs.files.keys()].filter((k) => k.endsWith('2026-08-20.json'))).toHaveLength(1)
  })

  it('A16 — redacts the warnings before they are committed', () => {
    const fs = memoryFs()
    writeArchive({
      brief: {
        ...brief,
        warnings: [
          'source "x" failed: POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef123456 -> 500',
        ],
      },
      archive,
      configHash: 'abc',
      scheduleId: 'morning',
      now: NOW,
      fs,
      secretValues: [],
    })
    const raw = fs.files.get('archive/2026/08/2026-08-20.json')!
    expect(raw).not.toContain('abcdef123456')
    expect(raw).toContain('REDACTED')
  })
})
