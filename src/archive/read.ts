import type { BriefDigest, Item } from '../config/schema'
import { nodeFs, type FsLike } from './fs'
import { archiveNames, parseArchiveFilename, recentDates } from './paths'
import type { IndexEntry } from '../render/markdown'

/** The `.json` half of the daily archive — the structured record of one issue. */
export interface ArchiveRecord {
  date: string
  slot: string | null
  scheduleId: string
  generatedAt: string
  configHash: string
  timezone: string
  lookbackHours: number
  itemCount: number
  items: Item[]
  /** §9 M3 — the issue's 导读, when the model wrote one. Absent on every pre-M3 record. */
  digest?: BriefDigest
  warnings: string[]
}

export function parseArchiveRecord(text: string): ArchiveRecord | null {
  try {
    const parsed = JSON.parse(text) as ArchiveRecord
    if (!parsed || !Array.isArray(parsed.items)) return null
    return parsed
  } catch {
    return null
  }
}

export function readRecord(
  baseDir: string,
  date: string,
  slot: string | null,
  fs: FsLike = nodeFs,
): ArchiveRecord | null {
  const text = fs.readFile(archiveNames(baseDir, date, slot).json)
  return text ? parseArchiveRecord(text) : null
}

/**
 * §3.5 — cross-day dedupe reads the last `days` of archived JSON instead of a separate
 * state file. Missing days are simply absent; a corrupt file is skipped, not fatal.
 */
export function readRecentItems(
  baseDir: string,
  today: string,
  days: number,
  fs: FsLike = nodeFs,
): { items: Item[]; scanned: number } {
  const items: Item[] = []
  let scanned = 0
  for (const date of recentDates(today, days)) {
    const { dir } = archiveNames(baseDir, date, null)
    for (const name of fs.readdir(dir)) {
      const parsed = parseArchiveFilename(name)
      if (!parsed || parsed.date !== date) continue
      const record = parseArchiveRecord(fs.readFile(`${dir}/${name}`) ?? '')
      if (!record) continue
      scanned++
      items.push(...record.items)
    }
  }
  return { items, scanned }
}

/** Every archived issue, newest first — the input to the `index.md` rebuild. */
export function listAllIssues(baseDir: string, fs: FsLike = nodeFs): IndexEntry[] {
  const entries: IndexEntry[] = []
  for (const year of fs.readdir(baseDir)) {
    if (!/^\d{4}$/.test(year)) continue
    for (const month of fs.readdir(`${baseDir}/${year}`)) {
      if (!/^\d{2}$/.test(month)) continue
      for (const name of fs.readdir(`${baseDir}/${year}/${month}`)) {
        const parsed = parseArchiveFilename(name)
        if (!parsed) continue
        const record = parseArchiveRecord(fs.readFile(`${baseDir}/${year}/${month}/${name}`) ?? '')
        entries.push({
          date: parsed.date,
          slot: parsed.slot,
          path: `${year}/${month}/${name.replace(/\.json$/, '.md')}`,
          itemCount: record?.itemCount ?? record?.items.length ?? 0,
        })
      }
    }
  }
  return entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return (a.slot ?? '').localeCompare(b.slot ?? '')
  })
}
