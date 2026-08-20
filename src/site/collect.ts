import type { Item } from '../config/schema'
import { nodeFs, type FsLike } from '../archive/fs'
import { parseArchiveFilename } from '../archive/paths'
import { parseArchiveRecord, type ArchiveRecord } from '../archive/read'

/** One archived issue, positioned inside the generated site. */
export interface SiteIssue {
  record: ArchiveRecord
  /** `2026/08/2026-08-20.html` — relative to the site root. */
  path: string
  /** `../../` — prefix that reaches the site root from this page. */
  up: string
}

export interface CollectResult {
  issues: SiteIssue[]
  /** Files that looked like archives but could not be parsed — reported, never fatal. */
  skipped: string[]
}

function upFrom(path: string): string {
  const depth = path.split('/').length - 1
  return '../'.repeat(depth)
}

/**
 * Read every archived `.json` under `baseDir`, newest first.
 *
 * A corrupt file is counted and skipped rather than failing the build: the site is a
 * derived view, and one bad day must not cost you the other three hundred.
 */
export function collectIssues(baseDir: string, fs: FsLike = nodeFs): CollectResult {
  const issues: SiteIssue[] = []
  const skipped: string[] = []

  for (const year of fs.readdir(baseDir)) {
    if (!/^\d{4}$/.test(year)) continue
    for (const month of fs.readdir(`${baseDir}/${year}`)) {
      if (!/^\d{2}$/.test(month)) continue
      for (const name of fs.readdir(`${baseDir}/${year}/${month}`)) {
        const parsed = parseArchiveFilename(name)
        if (!parsed) continue
        const full = `${baseDir}/${year}/${month}/${name}`
        const record = parseArchiveRecord(fs.readFile(full) ?? '')
        if (!record) {
          skipped.push(full)
          continue
        }
        const path = `${year}/${month}/${name.replace(/\.json$/, '.html')}`
        issues.push({ record, path, up: upFrom(path) })
      }
    }
  }

  issues.sort((a, b) => {
    if (a.record.date !== b.record.date) return a.record.date < b.record.date ? 1 : -1
    return (a.record.slot ?? '').localeCompare(b.record.slot ?? '')
  })
  return { issues, skipped }
}

export interface IssueSection {
  id: string
  title: string
  items: Item[]
}

/**
 * Regroup a flat archive record into sections.
 *
 * `order` is the current config's section order; a section that has since been removed
 * from the config still renders, under its raw id — an old issue must not lose items
 * because today's config changed.
 */
export function sectionsOf(
  record: ArchiveRecord,
  titles: Record<string, string>,
  order: string[],
): IssueSection[] {
  const grouped = new Map<string, Item[]>()
  for (const item of record.items) {
    const bucket = grouped.get(item.section)
    if (bucket) bucket.push(item)
    else grouped.set(item.section, [item])
  }

  const ranked = [...grouped.keys()].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    if (ia === ib) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })

  return ranked.map((id) => ({ id, title: titles[id] ?? id, items: grouped.get(id) ?? [] }))
}

/** Issues bucketed by `YYYY-MM`, newest month first — the index page's outline. */
export function groupByMonth(issues: SiteIssue[]): { month: string; issues: SiteIssue[] }[] {
  const months: { month: string; issues: SiteIssue[] }[] = []
  for (const issue of issues) {
    const month = issue.record.date.slice(0, 7)
    const last = months[months.length - 1]
    if (last && last.month === month) last.issues.push(issue)
    else months.push({ month, issues: [issue] })
  }
  return months
}
