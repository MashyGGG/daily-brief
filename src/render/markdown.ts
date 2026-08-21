import type { Item } from '../config/schema'
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
 * §1.2 — the LLM summary wins where it exists, and the source excerpt is the fallback
 * that makes every no-LLM path (unset key, `--no-llm`, dead endpoint) render as before.
 */
export function itemBody(item: Item): string | undefined {
  return item.summary ?? item.excerpt
}

/**
 * `takeaways` are omitted from the pushed markdown on purpose: WeCom caps a message at
 * 4096 bytes (§5.1) and bullets would double an entry's length for it. The archive, the
 * site and the mail — none of which have that ceiling — do print them, and §5.2's
 * per-recipient `detail` knob is what eventually makes this a choice rather than a rule.
 */
export function renderItemMarkdown(item: Item, index: number, withTakeaways = false): string {
  const lines = [`${index}. [${escapeMarkdown(item.title)}](${item.url})`]
  const meta = [item.source, hostOf(item.url)]
  if (typeof item.score === 'number' && item.score > 0) meta.push(`${item.score}`)
  lines.push(`   ${escapeMarkdown(meta.join(' · '))}`)
  const body = itemBody(item)
  if (body) lines.push(`   ${escapeMarkdown(body)}`)
  if (withTakeaways) {
    for (const takeaway of item.takeaways ?? []) lines.push(`   - ${escapeMarkdown(takeaway)}`)
  }
  return lines.join('\n')
}

/**
 * Rendered as an array of atomic blocks so the WeCom chunker can pack them
 * without ever cutting an entry in half (§3.4 / A8).
 */
export function renderMarkdownBlocks(brief: Brief): string[] {
  const blocks: string[] = []
  const sections = nonEmptySections(brief)
  blocks.push(`# ${brief.title} · ${brief.date}`)

  for (const section of sections) {
    blocks.push(`## ${escapeMarkdown(section.title)}`)
    section.items.forEach((item, i) => blocks.push(renderItemMarkdown(item, i + 1)))
  }

  if (brief.warnings.length > 0) {
    blocks.push(['> 抓取告警', ...brief.warnings.map((w) => `> - ${escapeMarkdown(w)}`)].join('\n'))
  }
  blocks.push(`—— ${brief.title} · ${brief.scheduleId} · ${brief.timezone}`)
  return blocks
}

export function renderMarkdown(brief: Brief): string {
  return renderMarkdownBlocks(brief).join('\n\n') + '\n'
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
        .map((item, i) => renderItemMarkdown(item, i + 1, true))
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
