import type { Item } from '../config/schema'
import { editionName, nonEmptySections, type Brief } from '../core/brief'
import { bodyFor, DIGEST_TITLE, type RenderOptions } from './markdown'
import { productionLines } from '../learning/content'

/** Plain-text rendering — also the multipart/alternative fallback for the HTML mail. */

function renderItem(item: Item, index: number, options: RenderOptions): string {
  const lines = [`${index}. ${item.title}`, `   ${item.url}`]
  const body = bodyFor(item, options)
  if (body) lines.push(`   ${body}`)
  // The plain-text part is what a text-only client shows instead of the HTML, so at
  // `full` it has to carry the same bullets the HTML does (§5.3).
  if (options.detail !== 'compact') {
    for (const takeaway of item.takeaways ?? []) lines.push(`   - ${takeaway}`)
    lines.push(...productionLines(item).map((line) => `   ${line}`))
  }
  return lines.join('\n')
}

export function renderTextBlocks(brief: Brief, options: RenderOptions = {}): string[] {
  const blocks: string[] = [`${editionName(brief)} · ${brief.date}`]
  const digest = brief.digest
    ? `【${options.digestTitle ?? DIGEST_TITLE}】\n${brief.digest.text}`
    : null
  if (digest && options.digestPosition !== 'bottom') blocks.push(digest)
  for (const section of nonEmptySections(brief)) {
    blocks.push(`【${section.title}】`)
    section.items.forEach((item, i) => blocks.push(renderItem(item, i + 1, options)))
  }
  if (digest && options.digestPosition === 'bottom') blocks.push(digest)
  if (brief.warnings.length > 0) {
    blocks.push(['抓取告警：', ...brief.warnings.map((w) => `- ${w}`)].join('\n'))
  }
  if (brief.learningReminder) {
    blocks.push(
      [
        '学习与制作步骤提醒 · 当前：' + brief.learningReminder.stage,
        '完成成果后手动切换阶段，不按天数自动升级。',
        ...(brief.learningReminder.lesson
          ? [
              `常青教材（不是今日新闻）：${brief.learningReminder.lesson.title} ${brief.learningReminder.lesson.url}`,
              `今天的小练习：${brief.learningReminder.lesson.task}`,
              `完成标准：${brief.learningReminder.lesson.doneWhen}`,
            ]
          : []),
        ...brief.learningReminder.steps,
        '完整手册：' + brief.learningReminder.guideUrl,
      ].join('\n'),
    )
  }
  return blocks
}

export function renderText(brief: Brief, options: RenderOptions = {}): string {
  return renderTextBlocks(brief, options).join('\n\n') + '\n'
}
