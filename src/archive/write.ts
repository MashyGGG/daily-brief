import type { ArchiveConfig } from '../config/schema'
import { itemsOf, type Brief } from '../core/brief'
import { redactDeep, collectSecretValues } from '../core/redact'
import { renderArchiveMarkdown, renderIndex } from '../render/markdown'
import { digestOptionsFor } from '../render'
import { nodeFs, type FsLike } from './fs'
import { archiveNames, indexPath } from './paths'
import { listAllIssues, type ArchiveRecord } from './read'

export interface WriteArchiveOptions {
  brief: Brief
  archive: ArchiveConfig
  configHash: string
  scheduleId: string
  now: Date
  fs?: FsLike
  /** Literal secret values to scrub from warnings; defaults to whatever env exposes. */
  secretValues?: string[]
}

export interface WriteArchiveResult {
  markdownPath: string
  jsonPath: string
  indexPath: string
  record: ArchiveRecord
}

/**
 * Write the three-piece archive: the day's `.md`, its `.json`, and a rebuilt `index.md`.
 *
 * Re-running the same date+slot **overwrites** rather than appends, so a manual re-run
 * never doubles the archive. Warnings are redacted before they are written, because this
 * repo is public (§3.5 / A16).
 */
export function writeArchive(options: WriteArchiveOptions): WriteArchiveResult {
  const { brief, archive, configHash, scheduleId, now } = options
  const fs = options.fs ?? nodeFs
  const secrets = options.secretValues ?? collectSecretValues()

  const names = archiveNames(archive.dir, brief.date, brief.slot)
  const items = itemsOf(brief)

  const record: ArchiveRecord = redactDeep(
    {
      date: brief.date,
      slot: brief.slot,
      scheduleId,
      generatedAt: brief.generatedAt,
      configHash,
      timezone: brief.timezone,
      lookbackHours: brief.lookbackHours,
      itemCount: items.length,
      items,
      // §1.2's reasoning, one level up: the archive keeps what was actually sent, so a
      // prompt change can be judged against it instead of against a memory of it.
      ...(brief.digest ? { digest: brief.digest } : {}),
      warnings: brief.warnings,
    },
    secrets,
  )

  fs.writeFile(names.json, JSON.stringify(record, null, 2) + '\n')
  fs.writeFile(
    names.markdown,
    redactDeep(renderArchiveMarkdown(brief, digestOptionsFor(brief)), secrets),
  )

  const index = indexPath(archive.dir)
  fs.writeFile(index, renderIndex(listAllIssues(archive.dir, fs), archive.indexKeep, now, brief.timezone))

  return { markdownPath: names.markdown, jsonPath: names.json, indexPath: index, record }
}
