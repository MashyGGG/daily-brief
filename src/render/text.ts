import type { Item } from '../config/schema'
import { nonEmptySections, type Brief } from '../core/brief'
import { bodyFor, type RenderOptions } from './markdown'

/** Plain-text rendering — also the multipart/alternative fallback for the HTML mail. */

function renderItem(item: Item, index: number, options: RenderOptions): string {
  const lines = [`${index}. ${item.title}`, `   ${item.url}`]
  const body = bodyFor(item, options)
  if (body) lines.push(`   ${body}`)
  // The plain-text part is what a text-only client shows instead of the HTML, so at
  // `full` it has to carry the same bullets the HTML does (§5.3).
  if (options.detail !== 'compact') {
    for (const takeaway of item.takeaways ?? []) lines.push(`   - ${takeaway}`)
  }
  return lines.join('\n')
}

export function renderTextBlocks(brief: Brief, options: RenderOptions = {}): string[] {
  const blocks: string[] = [`${brief.title} · ${brief.date}`]
  for (const section of nonEmptySections(brief)) {
    blocks.push(`【${section.title}】`)
    section.items.forEach((item, i) => blocks.push(renderItem(item, i + 1, options)))
  }
  if (brief.warnings.length > 0) {
    blocks.push(['抓取告警：', ...brief.warnings.map((w) => `- ${w}`)].join('\n'))
  }
  return blocks
}

export function renderText(brief: Brief, options: RenderOptions = {}): string {
  return renderTextBlocks(brief, options).join('\n\n') + '\n'
}
