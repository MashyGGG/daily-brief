import { appendFileSync } from 'node:fs'
import { totalItems } from './core/brief'
import type { RunResult } from './core/pipeline'

/**
 * §3.6 — every run writes what it produced into `$GITHUB_STEP_SUMMARY`, so the brief is
 * readable from the Actions run page without waiting on WeCom or mail.
 */
export function renderRunSummary(result: RunResult, opts: { dryRun: boolean }): string {
  const { brief, deliveries, sources } = result
  const lines: string[] = []

  lines.push(`## ${brief.title} · ${brief.date}${brief.slot ? ` · ${brief.slot}` : ''}`)
  lines.push('')
  lines.push(
    `schedule \`${result.schedule.id}\` · 回溯 ${brief.lookbackHours}h · ${totalItems(brief)} 条` +
      (opts.dryRun ? ' · **dry-run（未推送、未归档）**' : ''),
  )
  lines.push('')

  if (result.empty) {
    lines.push('> 今天没有达标内容 —— 不推送、不归档。')
    lines.push('')
  }

  if (sources.length > 0) {
    lines.push('### 抓取')
    lines.push('')
    lines.push('| 源 | 条目 | 耗时 | 状态 |')
    lines.push('| -- | ---- | ---- | ---- |')
    for (const s of sources) {
      lines.push(
        `| ${s.source} | ${s.items.length} | ${s.durationMs}ms | ${s.error ? `❌ ${s.error}` : '✅'} |`,
      )
    }
    lines.push('')
    lines.push(
      `去重丢弃：本次内 ${result.dedupeDropped.withinRun} 条，历史已推 ${result.dedupeDropped.alreadySeen} 条。`,
    )
    lines.push('')
  }

  if (deliveries.length > 0) {
    lines.push('### 推送')
    lines.push('')
    lines.push('| 收件人 | 渠道 | 状态 | 说明 |')
    lines.push('| ------ | ---- | ---- | ---- |')
    for (const d of deliveries) {
      const icon = d.status === 'sent' ? '✅' : d.status === 'skipped' ? '⏭️' : '❌'
      lines.push(`| ${d.recipient} | ${d.channel} | ${icon} ${d.status} | ${d.detail ?? ''} |`)
    }
    lines.push('')
  }

  if (result.archived) {
    lines.push(`归档：\`${result.archived.markdownPath}\``)
    lines.push('')
  }

  for (const section of brief.sections) {
    if (section.items.length === 0) continue
    lines.push(`### ${section.title}`)
    lines.push('')
    section.items.forEach((item, i) => {
      lines.push(`${i + 1}. [${item.title}](${item.url}) — \`${item.source}\` · ${item.rankScore}`)
    })
    lines.push('')
  }

  if (brief.warnings.length > 0) {
    lines.push('### 告警')
    lines.push('')
    for (const w of brief.warnings) lines.push(`- ${w}`)
    lines.push('')
  }

  return lines.join('\n')
}

export function writeStepSummary(text: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = env.GITHUB_STEP_SUMMARY
  if (!path) return
  try {
    appendFileSync(path, text + '\n', 'utf8')
  } catch (err) {
    console.warn(`[warn] could not write GITHUB_STEP_SUMMARY: ${(err as Error).message}`)
  }
}

/** Hand the workflow a definite answer about whether it should make an archive commit. */
export function writeStepOutputs(
  outputs: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = env.GITHUB_OUTPUT
  if (!path) return
  const body = Object.entries(outputs)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  try {
    appendFileSync(path, body + '\n', 'utf8')
  } catch (err) {
    console.warn(`[warn] could not write GITHUB_OUTPUT: ${(err as Error).message}`)
  }
}
