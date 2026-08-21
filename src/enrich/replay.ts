import type { BriefConfig, Item } from '../config/schema'
import type { BriefSection } from '../core/brief'
import { nodeFs, type FsLike } from '../archive/fs'
import { readRecord } from '../archive/read'
import { enrichSections, type EnrichStats } from './index'
import type { LlmFetch } from './llm'

/**
 * §9 M3, pulled forward — a prompt is only worth what it produces, and without this the
 * feedback loop on a prompt change is "wait until tomorrow morning". The archived JSON
 * still holds the original `excerpt` for every item (that is why §1.2 refuses to
 * overwrite it), so a replay costs one LLM call per item and zero fetches.
 *
 * Read-only by design: it prints, it does not rewrite the archive. Re-summarizing an
 * issue that has already been delivered would silently change what the public site says
 * happened that morning.
 */

export interface ReplayOptions {
  config: BriefConfig
  date: string
  env: NodeJS.ProcessEnv
  fetchImpl: LlmFetch
  fs?: FsLike
  /** Print the source excerpt next to the new summary. */
  diff: boolean
  noLlm?: boolean
  llmDryRun?: boolean
  sleep?: (ms: number) => Promise<void>
  describeError?: (err: unknown) => string
  log?: (message: string) => void
}

export interface ReplayResult {
  found: boolean
  slot: string | null
  stats: EnrichStats | null
  report: string
}

/** An archived issue's items, regrouped into the sections the current config declares. */
export function sectionsFromItems(items: Item[], config: BriefConfig): BriefSection[] {
  const byId = new Map(config.sections.map((s) => [s.id, [] as Item[]]))
  for (const item of items) byId.get(item.section)?.push(item)
  return config.sections
    .filter((s) => (byId.get(s.id)?.length ?? 0) > 0)
    .map((s) => ({ id: s.id, title: s.title, items: byId.get(s.id)! }))
}

function block(item: Item, diff: boolean): string[] {
  const lines = [`  ${item.title}`, `    源:  ${item.source}`]
  if (diff) lines.push(`    原文摘要: ${item.excerpt ?? '(无)'}`)
  lines.push(`    新摘要:   ${item.summary ?? '(未生成，保留原文摘要)'}`)
  for (const takeaway of item.takeaways ?? []) lines.push(`      - ${takeaway}`)
  if (item.summaryMeta) {
    lines.push(
      `    来源:     ${item.summaryMeta.model} · prompt v${item.summaryMeta.promptVersion} · ${item.summaryMeta.inputKind}`,
    )
  }
  return lines
}

export async function replayEnrich(options: ReplayOptions): Promise<ReplayResult> {
  const { config, date } = options
  const fs = options.fs ?? nodeFs
  // A single-schedule archive carries no slot suffix (§3.6); with several, try each id.
  const slots = [null, ...config.schedules.filter((s) => s.enabled).map((s) => s.id)]
  let slot: string | null = null
  let record = null
  for (const candidate of slots) {
    record = readRecord(config.archive.dir, date, candidate, fs)
    if (record) {
      slot = candidate
      break
    }
  }
  if (!record) {
    return {
      found: false,
      slot: null,
      stats: null,
      report: `No archived issue for ${date} under ${config.archive.dir}/.`,
    }
  }

  const enriched = await enrichSections(sectionsFromItems(record.items, config), config.llm, {
    env: options.env,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    disabled: options.noLlm,
    planOnly: options.llmDryRun,
    describeError: options.describeError,
    log: options.log,
  })

  const lines = [
    `# re-enrich ${record.date}${slot ? ` · ${slot}` : ''} — ${record.items.length} 条归档`,
    `模型 ${enriched.stats.model} · 状态 ${enriched.stats.status} · ` +
      `成功 ${enriched.stats.succeeded}/${enriched.stats.planned} · ${enriched.stats.durationMs}ms`,
    '',
  ]
  for (const section of enriched.sections) {
    const touched = section.items.filter((i) => i.summary)
    if (touched.length === 0) continue
    lines.push(`## ${section.title}`)
    for (const item of touched) lines.push(...block(item, options.diff), '')
  }
  for (const warning of enriched.warnings) lines.push(`! ${warning}`)

  return { found: true, slot, stats: enriched.stats, report: lines.join('\n') }
}
