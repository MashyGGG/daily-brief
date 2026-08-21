import type { Item } from '../config/schema'
import { truncate } from '../core/normalize'
import { localDate, nonEmptySections, type Brief } from '../core/brief'

/** Escape the markdown control characters that appear in real headlines. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1')
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * §5.2 — how much of an item a recipient gets. `full` is everything the enrich stage
 * produced; `compact` is the headline plus one line, because on a phone the brief is a
 * nudge toward the mail, not the read itself.
 */
export type Detail = 'full' | 'compact'

/** The `compact` character budget, when the caller has no `render.compactMaxChars` to pass. */
export const COMPACT_MAX_CHARS = 100

export interface RenderOptions {
  detail?: Detail
  /** `render.compactMaxChars`; ignored at `detail: full`. */
  compactMaxChars?: number
}

/**
 * §1.2 — the LLM summary wins where it exists, and the source excerpt is the fallback
 * that makes every no-LLM path (unset key, `--no-llm`, dead endpoint) render as before.
 */
export function itemBody(item: Item): string | undefined {
  return item.summary ?? item.excerpt
}

/**
 * What one item's body line says at this detail level. `compact` cuts at a sentence
 * boundary (`truncate`) rather than at the character, so the phone copy ends on a whole
 * thought — the M2 summaries are two or three sentences and the first one is the point.
 */
export function bodyFor(item: Item, options: RenderOptions = {}): string | undefined {
  const body = itemBody(item)
  if (!body || options.detail !== 'compact') return body
  return truncate(body, options.compactMaxChars ?? COMPACT_MAX_CHARS)
}

/**
 * `takeaways` are rendered only at `detail: full`. WeCom caps a message at 4096 bytes
 * (§5.1) and three bullets roughly double an entry, so the pushed copy would fragment
 * into a string of phone notifications. The mail, the archive and the site have no such
 * ceiling and print all of it.
 */
export function renderItemMarkdown(item: Item, index: number, options: RenderOptions = {}): string {
  const lines = [`${index}. [${escapeMarkdown(item.title)}](${item.url})`]
  const meta = [item.source, hostOf(item.url)]
  if (typeof item.score === 'number' && item.score > 0) meta.push(`${item.score}`)
  lines.push(`   ${escapeMarkdown(meta.join(' · '))}`)
  const body = bodyFor(item, options)
  if (body) lines.push(`   ${escapeMarkdown(body)}`)
  if (options.detail !== 'compact') {
    for (const takeaway of item.takeaways ?? []) lines.push(`   - ${escapeMarkdown(takeaway)}`)
  }
  return lines.join('\n')
}

/**
 * Rendered as an array of atomic blocks so the WeCom chunker can pack them
 * without ever cutting an entry in half (§3.4 / A8).
 */
export function renderMarkdownBlocks(brief: Brief, options: RenderOptions = {}): string[] {
  const blocks: string[] = []
  const sections = nonEmptySections(brief)
  blocks.push(`# ${brief.title} · ${brief.date}`)

  for (const section of sections) {
    blocks.push(`## ${escapeMarkdown(section.title)}`)
    section.items.forEach((item, i) => blocks.push(renderItemMarkdown(item, i + 1, options)))
  }

  if (brief.warnings.length > 0) {
    blocks.push(['> 抓取告警', ...brief.warnings.map((w) => `> - ${escapeMarkdown(w)}`)].join('\n'))
  }
  blocks.push(`—— ${brief.title} · ${brief.scheduleId} · ${brief.timezone}`)
  return blocks
}

export function renderMarkdown(brief: Brief, options: RenderOptions = {}): string {
  return renderMarkdownBlocks(brief, options).join('\n\n') + '\n'
}

/** The archived `.md` carries a little more provenance than the pushed copy. */
export function renderArchiveMarkdown(brief: Brief): string {
  const header = [
    `# ${brief.title} · ${brief.date}${brief.slot ? ` · ${brief.slot}` : ''}`,
    '',
    `- 生成时间：${brief.generatedAt}`,
    `- 时段：${brief.scheduleId}（回溯 ${brief.lookbackHours} 小时，时区 ${brief.timezone}）`,
  ].join('\n')

  const body = nonEmptySections(brief)
    .map((section) => {
      const items = section.items
        .map((item, i) => renderItemMarkdown(item, i + 1, { detail: 'full' }))
        .join('\n\n')
      return `## ${escapeMarkdown(section.title)}\n\n${items}`
    })
    .join('\n\n')

  const warnings =
    brief.warnings.length > 0
      ? `\n\n## 告警\n\n${brief.warnings.map((w) => `- ${escapeMarkdown(w)}`).join('\n')}`
      : ''

  return `${header}\n\n${body || '_今天没有达标内容。_'}${warnings}\n`
}

/** `index.md` — the last N issues, rebuilt on every run (§3.5). */
export interface IndexEntry {
  date: string
  slot: string | null
  path: string
  itemCount: number
}

export function renderIndex(
  entries: IndexEntry[],
  keep: number,
  now: Date,
  timeZone: string,
): string {
  const shown = entries.slice(0, keep)
  const lines = [
    '# 早报归档',
    '',
    `最近 ${shown.length} 期（共 ${entries.length} 期，历史文件永久保留）。`,
    `最后更新：${localDate(now, timeZone)}`,
    '',
    '| 日期 | 时段 | 条目 | 链接 |',
    '| ---- | ---- | ---- | ---- |',
    ...shown.map(
      (e) => `| ${e.date} | ${e.slot ?? '-'} | ${e.itemCount} | [${e.path}](${e.path}) |`,
    ),
  ]
  return lines.join('\n') + '\n'
}
