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
    suitableFor: text('suitableFor'),
    difficulty: text('difficulty'),
    requirements: text('requirements'),
    steps,
    limitations: text('limitations'),
    evidence,
  }
  return steps.length ||
    result.suitableFor ||
    result.difficulty ||
    result.requirements ||
    result.limitations
    ? result
    : undefined
}

/** Shared wording for HTML, text and archives. Unknown data stays visibly unknown. */
export function productionLines(item: Item): string[] {
  if (!item.productionNotes) return []
  const notes = item.productionNotes
  return [
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
