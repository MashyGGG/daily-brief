import { appendFileSync } from 'node:fs'
import { totalItems } from './core/brief'
import type { RunResult } from './core/pipeline'
import type { EnrichStats } from './enrich'

/**
 * Age of a source's newest item. Printed on every run so a feed drifting toward stale is
 * visible before it trips the warning in `core/health.ts` — a table of all-✅ rows tells
 * you the requests worked, not that the content is alive.
 */
function ageLabel(latestPublishedAt: string | undefined, generatedAt: string): string {
  if (!latestPublishedAt) return '—'
  const days =
    (new Date(generatedAt).getTime() - new Date(latestPublishedAt).getTime()) / 86_400_000
  if (!Number.isFinite(days)) return '—'
  if (days < 1) return `${Math.max(0, Math.round(days * 24))}h`
  return `${Math.round(days)}d`
}

const ENRICH_STATUS: Record<EnrichStats['status'], string> = {
  disabled: '关闭（配置 llm.enabled=false / --no-llm / LLM_ENABLED=false）',
  'no-key': '未配置密钥 —— 全部保留源摘要',
  nothing: '无条目通过门控',
  planned: '**--llm-dry-run（未真实调用）**',
  ran: '已运行',
}

/**
 * §6.1 — the LLM stage cannot fail the run, so the run page is the only place its cost
 * and its failures are visible. `gated` vs `capped` matters: the first is the config
 * working as intended, the second is a ceiling actually biting and worth retuning.
 */
function enrichLines(stats: EnrichStats): string[] {
  if (stats.status === 'disabled') return []
  const lines = [
    '### LLM 摘要',
    '',
    `状态：${ENRICH_STATUS[stats.status]} · 模型 \`${stats.model}\``,
  ]

  if (stats.status === 'no-key' || stats.status === 'nothing') {
    lines.push('', `门控跳过 ${stats.gated} 条，计划 ${stats.planned} 条。`, '')
    return lines
  }

  lines.push('')
  lines.push('| 计划 | 成功 | 失败 | 请求次数 | 输入 tok | 输出 tok | 耗时 |')
  lines.push('| ---- | ---- | ---- | -------- | -------- | -------- | ---- |')
  const inputTokens =
    stats.promptTokens > 0 ? String(stats.promptTokens) : `~${stats.estimatedInputTokens}`
  lines.push(
    `| ${stats.planned} | ${stats.succeeded} | ${stats.failed} | ${stats.attempts} | ` +
      `${inputTokens} | ${stats.completionTokens} | ${stats.durationMs}ms |`,
  )
  lines.push('')
  const capped: string[] = []
  if (stats.cappedByItems > 0) capped.push(`条数闸 ${stats.cappedByItems} 条`)
  if (stats.cappedByChars > 0) capped.push(`字符闸 ${stats.cappedByChars} 条`)
  lines.push(
    `门控跳过 ${stats.gated} 条` + (capped.length > 0 ? `；预算截断：${capped.join('、')}` : ''),
  )
  // §9 M2 — the one number that says whether the milestone is actually delivering. An
  // all-green LLM table over 12 items that were all summarized from `excerpt` is M1
  // wearing M2's clothes, and nothing else on this page would say so.
  const wantedFullText = stats.fullText + stats.fullTextFailed
  if (wantedFullText > 0) {
    lines.push('')
    lines.push(
      `正文抓取：${stats.fullText}/${wantedFullText} 成功（${stats.fetchDurationMs}ms）` +
        (stats.fullTextFailed > 0 ? `，${stats.fullTextFailed} 条退回源摘要` : ''),
    )
  }
  lines.push('')
  return lines
}

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
    lines.push('| 源 | 条目 | 最新 | 耗时 | 状态 |')
    lines.push('| -- | ---- | ---- | ---- | ---- |')
    for (const s of sources) {
      lines.push(
        `| ${s.source} | ${s.items.length} | ${ageLabel(s.latestPublishedAt, brief.generatedAt)} | ` +
          `${s.durationMs}ms | ${s.error ? `❌ ${s.error}` : '✅'} |`,
      )
    }
    lines.push('')
    lines.push(
      `去重丢弃：本次内 ${result.dedupeDropped.withinRun} 条，历史已推 ${result.dedupeDropped.alreadySeen} 条。`,
    )
    lines.push('')
  }

  lines.push(...enrichLines(result.enrich))

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
