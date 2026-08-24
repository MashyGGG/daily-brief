import { renderExplain } from './collect'
import type { RunPublishResult } from './run'

const ICON: Record<string, string> = {
  created: '✅',
  updated: '♻️',
  published: '🚀',
  skipped: '⏭️',
  failed: '❌',
}

/**
 * §3.6's rule, applied to publishing: the run page must say what went out without
 * anyone opening Notion or the 草稿箱. The selection table is printed whenever a line was
 * skipped for want of items — that is exactly the moment "why only 9 today" gets asked.
 */
export function renderPublishSummary(result: RunPublishResult, opts: { dryRun: boolean }): string {
  const lines: string[] = []
  lines.push(`## publish · ${result.schedule.id}${opts.dryRun ? ' · **dry-run**' : ''}`)
  lines.push('')

  for (const day of result.days) {
    const issue = day.collect.issue
    lines.push(`### ${day.publishDate}`)
    lines.push('')
    if (!issue) {
      lines.push(`> ⏭️ ${day.collect.detail}`)
      lines.push('')
      // The one case where the table earns its place on the run page.
      if (day.collect.reason === 'too-few-items') {
        lines.push('```')
        lines.push(renderExplain(day.collect.explain))
        lines.push('```')
        lines.push('')
      }
      continue
    }

    const sections = issue.sections.map((s) => `${s.title} ${s.items.length}`).join(' · ')
    lines.push(`${issue.itemIds.length} 条 · ${sections}`)
    lines.push(
      `取材：${issue.sources.map((s) => `${s.date}${s.slot ? `.${s.slot}` : ''}`).join(' · ')}`,
    )
    lines.push('')

    if (day.results.length > 0) {
      lines.push('| 目标 | 平台 | 状态 | 说明 | 链接 |')
      lines.push('| ---- | ---- | ---- | ---- | ---- |')
      for (const r of day.results) {
        lines.push(
          `| ${r.target} | ${r.platform} | ${ICON[r.status] ?? ''} ${r.status} | ` +
            `${r.detail ?? ''} | ${r.url ? `[open](${r.url})` : ''} |`,
        )
      }
      lines.push('')
    }
    if (day.explainText) {
      lines.push('```')
      lines.push(day.explainText)
      lines.push('```')
      lines.push('')
    }
  }

  if (result.warnings.length > 0) {
    lines.push('### 告警')
    lines.push('')
    for (const w of result.warnings) lines.push(`- ${w}`)
    lines.push('')
  }
  return lines.join('\n')
}
