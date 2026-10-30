import type { Item } from '../config/schema'
import { parseModelJson, sanitizeText } from '../enrich/sanitize'

/** Generated notes carry the actual input provenance, never a model's self-rating. */
export function productionNotes(
  raw: string,
  evidence: 'fulltext' | 'excerpt',
): Item['productionNotes'] {
  const parsed = parseModelJson(raw) as { productionNotes?: unknown } | null
  const value = parsed?.productionNotes
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  const text = (key: string) =>
    typeof fields[key] === 'string'
      ? sanitizeText(fields[key] as string, key === 'requirements' ? 240 : 160) || undefined
      : undefined
  const steps = Array.isArray(fields.steps)
    ? [
        ...new Set(
          fields.steps
            .filter((s): s is string => typeof s === 'string')
            .map((s) => sanitizeText(s, 100))
            .filter(Boolean),
        ),
      ].slice(0, 5)
    : []
  const result = {
    whyItMatters: text('whyItMatters'),
    nextAction: text('nextAction'),
    suitableFor: text('suitableFor'),
    difficulty: text('difficulty'),
    requirements: text('requirements'),
    steps,
    limitations: text('limitations'),
    evidence,
  }
  return result.whyItMatters ||
    result.nextAction ||
    steps.length ||
    result.suitableFor ||
    result.difficulty ||
    result.requirements ||
    result.limitations
    ? result
    : undefined
}

/** Shared wording for HTML, text and archives. Unknown data stays visibly unknown. */
export function productionLines(item: Item): string[] {
  const editorial = item.editorial
  const lines = editorial
    ? [
        `内容类型：${{ news: '资讯', tutorial: '教程', release: '技术更新', review: '技术评测' }[editorial.kind]}${editorial.difficulty ? ` · 预估难度：${editorial.difficulty}` : ''}`,
        `入选依据：${editorial.reason}`,
        `建议行动：${item.productionNotes?.nextAction ?? editorial.action}`,
        `来源发布时间：${item.publishedAt.slice(0, 10)}；事件发生日期请核对原文。`,
        `内容依据：${editorial.evidence === 'fulltext' ? '已提取正文' : '仅来源摘要，尚未核实全文'}。`,
      ]
    : []
  if (!item.productionNotes) return lines
  const notes = item.productionNotes
  return [
    ...lines,
    ...(notes.whyItMatters ? [`与你的关系：${notes.whyItMatters}`] : []),
    `适用环节：${notes.suitableFor ?? '原文未说明'}`,
    `难度：${notes.difficulty ?? '原文未说明'}`,
    `前置条件：${notes.requirements ?? '原文未说明'}`,
    ...(notes.steps.length
      ? notes.steps.map((s, i) => `步骤 ${i + 1}：${s}`)
      : ['操作步骤：原文未提供可提取步骤']),
    `限制：${notes.limitations ?? '原文未说明'}`,
    `整理依据：${notes.evidence === 'fulltext' ? '已提取正文' : '仅来源摘要'}；未经本项目运行验证。`,
  ]
}
