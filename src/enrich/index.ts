import type { Item, LlmConfig, SummaryMeta } from '../config/schema'
import type { BriefSection } from '../core/brief'
import { createLlmClient, type LlmClient, type LlmFetch } from './llm'
import { planEnrichment, type EnrichPlan, type EnrichTask } from './policy'
import { PROMPT_VERSION, systemPrompt, userPrompt } from './prompt'
import { sanitizeResponse } from './sanitize'

/**
 * §6.1 — the enrich stage never throws and never changes the exit code. Every failure
 * mode here has the same fallback: the item keeps its `excerpt` and the brief goes out
 * looking exactly like it did before any of this existed.
 */

export interface EnrichContext {
  env: NodeJS.ProcessEnv
  fetchImpl: LlmFetch
  sleep?: (ms: number) => Promise<void>
  /** `--no-llm`, or `LLM_ENABLED=false` as the workflow-level breaker. */
  disabled?: boolean
  /** `--llm-dry-run`: build the plan, report it, call nothing. */
  planOnly?: boolean
  /** Shared with the pipeline so a leaked key cannot reach a committed warning. */
  describeError?: (err: unknown) => string
  log?: (message: string) => void
}

export type EnrichStatus =
  | 'disabled' // config says no, or --no-llm
  | 'no-key' // enabled but never configured — not a failure, just not set up
  | 'planned' // --llm-dry-run
  | 'nothing' // enabled and configured, but the gates chose nobody
  | 'ran'

export interface EnrichStats {
  status: EnrichStatus
  model: string
  planned: number
  gated: number
  cappedByItems: number
  cappedByChars: number
  succeeded: number
  failed: number
  /** HTTP attempts, so a retry storm is visible even when every item eventually lands. */
  attempts: number
  promptTokens: number
  completionTokens: number
  /** Local estimate, and the only number `--llm-dry-run` can offer. */
  estimatedInputTokens: number
  durationMs: number
}

export interface EnrichResult {
  sections: BriefSection[]
  stats: EnrichStats
  /** Aggregated failures, ready for `brief.warnings`. */
  warnings: string[]
}

function emptyStats(status: EnrichStatus, model: string, plan?: EnrichPlan): EnrichStats {
  return {
    status,
    model,
    planned: plan?.tasks.length ?? 0,
    gated: plan?.gated ?? 0,
    cappedByItems: plan?.cappedByItems ?? 0,
    cappedByChars: plan?.cappedByChars ?? 0,
    succeeded: 0,
    failed: 0,
    attempts: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedInputTokens: plan?.tasks.reduce((n, t) => n + t.estimatedInputTokens, 0) ?? 0,
    durationMs: 0,
  }
}

/** `LLM_ENABLED=false|0|no|off` is the break-glass switch; anything else leaves config in charge. */
export function envDisables(env: NodeJS.ProcessEnv): boolean {
  const raw = env.LLM_ENABLED?.trim().toLowerCase()
  return raw === 'false' || raw === '0' || raw === 'no' || raw === 'off'
}

/** At most `size` calls in flight; order of completion is irrelevant, results are keyed by id. */
async function pool<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await worker(items[index]!)
    }
  })
  await Promise.all(runners)
}

/**
 * One item's call, isolated. Resolves to `null` on any failure — the same shape as a
 * gated item, so the caller has one path for "no summary" rather than two.
 */
async function summarizeOne(
  task: EnrichTask,
  client: LlmClient,
  stats: EnrichStats,
  onFailure: (message: string) => void,
  describeError: (err: unknown) => string,
): Promise<{ id: string; summary: string; takeaways: string[]; meta: SummaryMeta } | null> {
  try {
    const result = await client.complete(
      systemPrompt(task.policy),
      userPrompt({ title: task.item.title, source: task.item.source, text: task.input }),
    )
    stats.attempts += result.attempts
    stats.promptTokens += result.usage?.promptTokens ?? 0
    stats.completionTokens += result.usage?.completionTokens ?? 0
    const clean = sanitizeResponse(result.content, task.policy.maxChars)
    if (!clean) {
      onFailure('model returned nothing usable after sanitizing')
      return null
    }
    return {
      id: task.item.id,
      summary: clean.summary,
      takeaways: clean.takeaways,
      meta: {
        by: 'llm',
        model: client.model,
        promptVersion: PROMPT_VERSION,
        inputKind: task.inputKind,
      },
    }
  } catch (err) {
    // An attempt that ended in a throw still cost the clock; count it so the summary
    // table's `attempts` stays honest about what the run actually spent.
    stats.attempts += 1
    onFailure(describeError(err))
    return null
  }
}

function applySummaries(
  sections: BriefSection[],
  summaries: Map<string, { summary: string; takeaways: string[]; meta: SummaryMeta }>,
): BriefSection[] {
  if (summaries.size === 0) return sections
  return sections.map((section) => ({
    ...section,
    items: section.items.map((item): Item => {
      const found = summaries.get(item.id)
      if (!found) return item
      return {
        ...item,
        summary: found.summary,
        ...(found.takeaways.length > 0 ? { takeaways: found.takeaways } : {}),
        summaryMeta: found.meta,
      }
    }),
  }))
}

/** Distinct failure reasons with counts — a run that fails 12 times fails for 1 or 2 reasons. */
function aggregate(failures: string[], limit = 3): string[] {
  const counts = new Map<string, number>()
  for (const message of failures) counts.set(message, (counts.get(message) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([message, n]) => `llm: ${n} item(s) fell back to the source excerpt — ${message}`)
}

/**
 * §1.1 — runs on the already-selected items, so `section.limit` is a structural ceiling
 * on spend that no configuration mistake can lift.
 */
export async function enrichSections(
  sections: BriefSection[],
  llm: LlmConfig,
  ctx: EnrichContext,
): Promise<EnrichResult> {
  const log = ctx.log ?? (() => {})
  const describeError = ctx.describeError ?? ((err) => (err as Error)?.message ?? String(err))
  const model = llm.provider.model

  if (!llm.enabled || ctx.disabled || envDisables(ctx.env)) {
    return { sections, stats: emptyStats('disabled', model), warnings: [] }
  }

  const apiKey = ctx.env[llm.provider.apiKeyRef]?.trim()
  const plan = planEnrichment(sections, llm)

  if (!apiKey) {
    // Not configured is not a failure: it produces a run-summary row on the Actions page
    // and nothing in the brief, because a warning that fires every single morning is a
    // warning nobody reads by the end of the week.
    log(`llm: ${llm.provider.apiKeyRef} is not set — keeping source excerpts`)
    return { sections, stats: emptyStats('no-key', model, plan), warnings: [] }
  }

  if (plan.tasks.length === 0) {
    return { sections, stats: emptyStats('nothing', model, plan), warnings: [] }
  }

  if (ctx.planOnly) {
    for (const task of plan.tasks) {
      log(
        `llm-dry-run: ${task.sectionId} · ${task.item.source} · ~${task.estimatedInputTokens} tok · ${task.item.title}`,
      )
    }
    return { sections, stats: emptyStats('planned', model, plan), warnings: [] }
  }

  const stats = emptyStats('ran', model, plan)
  const started = Date.now()
  const client = createLlmClient({
    provider: llm.provider,
    apiKey,
    baseUrl: ctx.env.LLM_BASE_URL,
    fetchImpl: ctx.fetchImpl,
    sleep: ctx.sleep,
  })

  const summaries = new Map<string, { summary: string; takeaways: string[]; meta: SummaryMeta }>()
  const failures: string[] = []

  await pool(plan.tasks, llm.provider.concurrency, async (task) => {
    const result = await summarizeOne(
      task,
      client,
      stats,
      (message) => failures.push(message),
      describeError,
    )
    if (result) {
      summaries.set(result.id, {
        summary: result.summary,
        takeaways: result.takeaways,
        meta: result.meta,
      })
    }
  })

  stats.succeeded = summaries.size
  stats.failed = plan.tasks.length - summaries.size
  stats.durationMs = Date.now() - started
  log(`llm: ${stats.succeeded}/${plan.tasks.length} summarized in ${stats.durationMs}ms`)

  return { sections: applySummaries(sections, summaries), stats, warnings: aggregate(failures) }
}

export { planEnrichment, resolvePolicy, passesWhen, titleLanguage, estimateTokens } from './policy'
export type { EnrichPlan, EnrichTask, ResolvedPolicy } from './policy'
export { sanitizeResponse, sanitizeText, sanitizeTakeaways } from './sanitize'
export { PROMPT_VERSION } from './prompt'
export type { LlmFetch } from './llm'
