/**
 * §3.5 — archive layout, kept in POSIX form so paths are identical on every platform
 * and stable in git.
 *
 *   archive/2026/08/2026-08-20.md            single schedule
 *   archive/2026/08/2026-08-20.morning.md    multiple schedules enabled
 */

export interface ArchiveNames {
  dir: string
  markdown: string
  json: string
  /** Path relative to the archive dir — what index.md links to. */
  relativeMarkdown: string
}

export function archiveNames(baseDir: string, date: string, slot: string | null): ArchiveNames {
  const [year, month] = date.split('-')
  if (!year || !month) throw new Error(`Invalid archive date "${date}", expected YYYY-MM-DD`)
  const dir = `${baseDir}/${year}/${month}`
  const stem = slot ? `${date}.${slot}` : date
  return {
    dir,
    markdown: `${dir}/${stem}.md`,
    json: `${dir}/${stem}.json`,
    relativeMarkdown: `${year}/${month}/${stem}.md`,
  }
}

export function indexPath(baseDir: string): string {
  return `${baseDir}/index.md`
}

/**
 * The slot a weekly review is archived under (§9 M3): `2026-08-24.weekly.json`, next to
 * that Monday's own `2026-08-24.json`.
 */
export const WEEKLY_SLOT = 'weekly'

/**
 * True for an archive file that REPRINTS items already archived under their own day.
 *
 * A weekly review holds up to a week of items but is filed under the day it was sent, so
 * any reader asking "what was published on this date" must skip it — otherwise the same
 * item is counted twice, and items far older than the reader's own window come back to
 * life. Two readers care: cross-day dedupe (`readRecentItems`) and the weekly itself
 * (`collectWeekly`). The site and `index.md` deliberately do not: there, a reprint is a
 * page readers want.
 */
export function isReprint(slot: string | null): boolean {
  return slot === WEEKLY_SLOT
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.([a-z0-9-]+))?\.json$/i

export function parseArchiveFilename(name: string): { date: string; slot: string | null } | null {
  const match = FILE_RE.exec(name)
  if (!match) return null
  return { date: match[1]!, slot: match[2] ?? null }
}

/** The `YYYY-MM-DD` of `n` days before `date` (UTC arithmetic on a plain date string). */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const at = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1))
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/** The last `count` dates ending at (and including) `date`, newest first. */
export function recentDates(date: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftDate(date, -i))
}
