import type { Item } from '../config/schema'
import { nonEmptySections, type Brief } from '../core/brief'

/** Plain-text rendering — also the multipart/alternative fallback for the HTML mail. */

function renderItem(item: Item, index: number): string {
  const lines = [`${index}. ${item.title}`, `   ${item.url}`]
  if (item.excerpt) lines.push(`   ${item.excerpt}`)
  return lines.join('\n')
}

export function renderTextBlocks(brief: Brief): string[] {
  const blocks: string[] = [`${brief.title} · ${brief.date}`]
  for (const section of nonEmptySections(brief)) {
    blocks.push(`【${section.title}】`)
    section.items.forEach((item, i) => blocks.push(renderItem(item, i + 1)))
  }
  if (brief.warnings.length > 0) {
    blocks.push(['抓取告警：', ...brief.warnings.map((w) => `- ${w}`)].join('\n'))
  }
  return blocks
}

export function renderText(brief: Brief): string {
  return renderTextBlocks(brief).join('\n\n') + '\n'
}
