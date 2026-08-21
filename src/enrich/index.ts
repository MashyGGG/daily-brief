import type { Item, LlmConfig, SummaryMeta } from '../config/schema'
import type { BriefSection } from '../core/brief'
import { extractArticle, type ExtractFetch } from './extract'
import { createLlmClient, resolveProvider, type LlmClient, type LlmFetch } from './llm'
import { cut, planEnrichment, type EnrichPlan, type EnrichTask } from './policy'
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
  /**
   * §9 M2 — the seam used to read the article itself. Left unset, `fetchFullText` degrades
   * to M1 behaviour (the excerpt) rather than failing: a missing seam is a missing feature,
   * not a broken run.
   */
  extractFetchImpl?: ExtractFetch
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
  /** Items whose article was actually read — the M2 number that says the milestone works. */
  fullText: number
  /** Items that asked for the article and got the excerpt instead. Quality loss, not failure. */
  fullTextFailed: number
  fetchDurationMs: number
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
    fullText: 0,
    fullTextFailed: 0,
    fetchDurationMs: 0,
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
function aggregate(failures: string[], prefix: string, limit = 3): string[] {
  const counts = new Map<string, number>()
  for (const message of failures) counts.set(message, (counts.get(message) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([message, n]) => `${prefix}: ${n} item(s) fell back to the source excerpt — ${message}`)
}

/**
 * Whether a run's failed extractions are worth putting in front of the reader.
 *
 * They are not, one site at a time: a JS-only page or a paywall fails the same way every
 * single morning, and M1 already learned (record #3) that a warning which fires daily is
 * a warning nobody reads by the end of the week — which makes the real ones invisible
 * too. A majority of attempts failing is different: that is the network, the runner, or
 * the extractor itself, and it did not look like that yesterday.
 *
 * The exact count is on the Actions run page either way (`正文抓取：N/M`), which is where
 * "oschina still can't be read" belongs.
 */
function extractWarnings(failures: string[], stats: EnrichStats): string[] {
  if (stats.fullTextFailed <= stats.fullText) return []
  return aggregate(failures, 'extract')
}

/**
 * §9 M2 — read the articles the policy asked for, in place. Mutates each task's `input`
 * and `inputKind` on success and leaves them alone on failure, so the LLM stage below has
 * exactly one code path whether the fetch worked, timed out, or was never wired up.
 *
 * A failure here is a quality loss, not an incident: the item still gets summarized, just
 * from the excerpt the feed shipped. Which is why it does not always reach `warnings` —
 * see `extractWarnings`.
 */
async function fetchFullTexts(
  tasks: EnrichTask[],
  llm: LlmConfig,
  ctx: EnrichContext,
  stats: EnrichStats,
  onFailure: (message: string) => void,
  describeError: (err: unknown) => string,
): Promise<void> {
  const wanted = tasks.filter((t) => t.wantsFullText)
  if (wanted.length === 0) return
  const fetchImpl = ctx.extractFetchImpl
  if (!fetchImpl) {
    stats.fullTextFailed += wanted.length
    onFailure('no full-text fetcher wired up')
    return
  }

  const started = Date.now()
  await pool(wanted, llm.extract.concurrency, async (task) => {
    try {
      const article = await extractArticle(task.item.url, {
        fetchImpl,
        config: llm.extract,
        maxChars: llm.budget.maxInputCharsPerItem,
      })
      task.input = cut(article.text, llm.budget.maxInputCharsPerItem)
      task.inputKind = 'fulltext'
      stats.fullText++
    } catch (err) {
      stats.fullTextFailed++
      onFailure(describeError(err))
    }
  })
  stats.fetchDurationMs = Date.now() - started
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
  // Resolved before the early returns so every status line names the model that would
  // have run, not the one the committed config happens to still mention.
  const provider = resolveProvider(llm.provider, ctx.env)
  const model = provider.model

  if (!llm.enabled || ctx.disabled || envDisables(ctx.env)) {
    return { sections, stats: emptyStats('disabled', model), warnings: [] }
  }

  const apiKey = ctx.env[provider.apiKeyRef]?.trim()
  const plan = planEnrichment(sections, llm)

  if (!apiKey) {
    // Not configured is not a failure: it produces a run-summary row on the Actions page
    // and nothing in the brief, because a warning that fires every single morning is a
    // warning nobody reads by the end of the week.
    log(`llm: ${provider.apiKeyRef} is not set — keeping source excerpts`)
    return { sections, stats: emptyStats('no-key', model, plan), warnings: [] }
  }

  if (plan.tasks.length === 0) {
    return { sections, stats: emptyStats('nothing', model, plan), warnings: [] }
  }

  if (ctx.planOnly) {
    for (const task of plan.tasks) {
      // Nothing is fetched here either: a dry run that pulled 12 articles would be a dry
      // run with a wall-clock cost and a footprint in somebody's access log.
      const kind = task.wantsFullText ? 'fulltext(planned)' : 'excerpt'
      log(
        `llm-dry-run: ${task.sectionId} · ${task.item.source} · ${kind} · ` +
          `~${task.estimatedInputTokens} tok · ${task.item.title}`,
      )
    }
    return { sections, stats: emptyStats('planned', model, plan), warnings: [] }
  }

  const stats = emptyStats('ran', model, plan)
  const started = Date.now()
  const client = createLlmClient({
    provider,
    apiKey,
    fetchImpl: ctx.fetchImpl,
    sleep: ctx.sleep,
  })

  const summaries = new Map<string, { summary: string; takeaways: string[]; meta: SummaryMeta }>()
  const failures: string[] = []
  const extractFailures: string[] = []

  await fetchFullTexts(
    plan.tasks,
    llm,
    ctx,
    stats,
    (message) => extractFailures.push(message),
    describeError,
  )
  if (stats.fullText + stats.fullTextFailed > 0) {
    log(
      `extract: ${stats.fullText}/${stats.fullText + stats.fullTextFailed} articles read ` +
        `in ${stats.fetchDurationMs}ms`,
    )
  }

  await pool(plan.tasks, provider.concurrency, async (task) => {
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

  return {
    sections: applySummaries(sections, summaries),
    stats,
    warnings: [...extractWarnings(extractFailures, stats), ...aggregate(failures, 'llm')],
  }
}

export { planEnrichment, resolvePolicy, passesWhen, titleLanguage, estimateTokens } from './policy'
export type { EnrichPlan, EnrichTask, ResolvedPolicy } from './policy'
export { sanitizeResponse, sanitizeText, sanitizeTakeaways } from './sanitize'
export { extractArticle, htmlToText, isFetchableUrl, ExtractError } from './extract'
export type { ExtractFetch } from './extract'
export { PROMPT_VERSION } from './prompt'
export type { LlmFetch } from './llm'
