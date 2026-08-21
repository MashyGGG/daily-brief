import type { Item, LlmConfig, LlmPolicyOverride, LlmStyle } from '../config/schema'
import type { BriefSection } from '../core/brief'

/**
 * §2.2 — everything here is a pure function of the config and the already-selected items.
 * No network, no clock, no env: what the LLM gets called on is decided before anything is
 * spent, which is what makes `--llm-dry-run` able to promise the same answer as the run.
 */

export interface ResolvedPolicy {
  summarize: boolean
  style: LlmStyle
  language: string
  maxChars: number
  fetchFullText: boolean
}

/**
 * source > section > defaults, most specific wins. Absent and `false` are different
 * things: an override that says nothing about `summarize` must not cancel the section's
 * opt-in, which is why `llmPolicyOverride` makes every field optional.
 */
export function resolvePolicy(
  llm: LlmConfig,
  sourceName: string,
  sectionId: string,
): ResolvedPolicy {
  const layers: (LlmPolicyOverride | undefined)[] = [
    llm.sections[sectionId],
    llm.sources[sourceName],
  ]
  const pick = <K extends keyof ResolvedPolicy>(key: K): ResolvedPolicy[K] => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const value = layers[i]?.[key as keyof LlmPolicyOverride]
      if (value !== undefined) return value as ResolvedPolicy[K]
    }
    return llm.defaults[key] as ResolvedPolicy[K]
  }
  return {
    summarize: pick('summarize'),
    style: pick('style'),
    language: pick('language'),
    maxChars: pick('maxChars'),
    fetchFullText: pick('fetchFullText'),
  }
}

/**
 * Whether a title is already Han-dominant. Counted against letters rather than all
 * characters so `DeepSeek Harness 公测一周迎来多模态大招` — mostly Latin by character
 * count, unmistakably Chinese to a reader — is not misread as English.
 */
export function titleLanguage(title: string): 'zh' | 'other' {
  let han = 0
  let letters = 0
  for (const ch of title) {
    if (!/\p{L}/u.test(ch)) continue
    letters++
    if (/\p{Script=Han}/u.test(ch)) han++
  }
  if (letters === 0) return 'other'
  return han / letters >= 0.3 ? 'zh' : 'other'
}

/** Compiled once per run; no `g` flag, so `.test` carries no `lastIndex` between items. */
export function compileWhenPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, 'i'))
}

export interface WhenContext {
  /** 0-based position within the section, in rank order. */
  rankInSection: number
  junkPatterns: readonly RegExp[]
  /** §9 M2 — whether this item's policy will send the article rather than the excerpt. */
  fetchFullText: boolean
}

/**
 * The quality gate. An item passes when its own excerpt is NOT already good enough —
 * missing, too short, or matching a known-junk fingerprint — and it is not excluded by
 * the two structural caps.
 *
 * With neither `excerptShorterThan` nor `excerptMatches` configured the excerpt half is
 * off rather than closed: an unconfigured trigger means "don't judge by excerpt", not
 * "reject everything".
 *
 * ★ M2 — the excerpt half does not apply to a full-text item. The question it asks is
 * "is this item's own excerpt already as good as what we would send the model", and that
 * question only makes sense while the excerpt IS what gets sent. Once the article does,
 * a well-written 300-character teaser is no longer evidence that the model has nothing to
 * add — §0.2 makes exactly the opposite argument. The structural caps (`topPerSection`)
 * and the budget still bound the spend; this only stops the length of a teaser from
 * cancelling a deliberate `fetchFullText: true`.
 */
export function passesWhen(item: Item, when: LlmConfig['when'], ctx: WhenContext): boolean {
  if (when.topPerSection > 0 && ctx.rankInSection >= when.topPerSection) return false
  if (when.titleLanguageNot && titleLanguage(item.title) === when.titleLanguageNot) return false
  if (ctx.fetchFullText) return true

  const judgesExcerpt = when.excerptShorterThan > 0 || ctx.junkPatterns.length > 0
  if (!judgesExcerpt) return true

  const excerpt = item.excerpt ?? ''
  if (excerpt.trim() === '') return true
  if (when.excerptShorterThan > 0 && [...excerpt].length < when.excerptShorterThan) return true
  return ctx.junkPatterns.some((re) => re.test(excerpt))
}

export interface EnrichTask {
  item: Item
  sectionId: string
  policy: ResolvedPolicy
  /**
   * What actually gets sent, already cut to `budget.maxInputCharsPerItem`. Planning fills
   * it with the excerpt; the M2 extract stage overwrites it when the fetch succeeds, which
   * is the whole difference between "a shorter version of the excerpt" and "you don't
   * need to click the link".
   */
  input: string
  /** What `input` currently holds — mutated by the extract stage, archived in `summaryMeta`. */
  inputKind: 'excerpt' | 'fulltext'
  /** Whether the resolved policy asked for the article. A failed fetch leaves this true. */
  wantsFullText: boolean
  /** What this task was charged against `maxTotalInputChars` (see `planEnrichment`). */
  reservedChars: number
  estimatedInputTokens: number
}

export interface EnrichPlan {
  tasks: EnrichTask[]
  /** Items the switches or the quality gate declined — the cheap, intended skips. */
  gated: number
  /** Items a budget ceiling declined, split by which ceiling. Non-zero means retune. */
  cappedByItems: number
  cappedByChars: number
  /** Reserved, not spent: a full-text task books its per-item ceiling before it fetches. */
  inputChars: number
}

/**
 * Rough token count: CJK runs about one token per character, Latin about four characters
 * per token. Used only for the `--llm-dry-run` estimate and the run summary, never to
 * make a decision — the character budgets are what actually gate spend.
 */
export function estimateTokens(text: string): number {
  let han = 0
  let rest = 0
  for (const ch of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(ch)) han++
    else rest++
  }
  return Math.ceil(han + rest / 4)
}

export function cut(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/**
 * Tokens a full-text task might cost, before anything has been fetched. The ratio is
 * guessed from the title's script because that is the one signal available at plan time
 * and it is a good one: a Chinese site writes a Chinese headline. Display only — the
 * character budgets are what actually gate spend.
 */
function reservedTokens(title: string, chars: number): number {
  return Math.ceil(chars / (titleLanguage(title) === 'zh' ? 1 : 4))
}

/**
 * Turn the selected brief into the exact list of LLM calls this run will make.
 *
 * Candidates are taken **round-robin by rank position** rather than section by section:
 * with six sections asking for their top 3 and a 12-item budget, walking sections in order
 * would spend everything on the first four and leave the last two with nothing, silently.
 * Round-robin makes the budget bite evenly, and within a rank position the section order
 * still decides ties, so the ordering stays deterministic.
 */
export function planEnrichment(sections: BriefSection[], llm: LlmConfig): EnrichPlan {
  const plan: EnrichPlan = {
    tasks: [],
    gated: 0,
    cappedByItems: 0,
    cappedByChars: 0,
    inputChars: 0,
  }
  if (!llm.enabled) return plan

  const junkPatterns = compileWhenPatterns(llm.when.excerptMatches)
  const candidates: { item: Item; sectionId: string; policy: ResolvedPolicy; rank: number }[] = []
  const deepest = Math.max(0, ...sections.map((s) => s.items.length))

  for (let rank = 0; rank < deepest; rank++) {
    for (const section of sections) {
      const item = section.items[rank]
      if (!item) continue
      const policy = resolvePolicy(llm, item.source, section.id)
      const when = {
        rankInSection: rank,
        junkPatterns,
        fetchFullText: policy.fetchFullText,
      }
      if (!policy.summarize || !passesWhen(item, llm.when, when)) {
        plan.gated++
        continue
      }
      candidates.push({ item, sectionId: section.id, policy, rank })
    }
  }

  for (const candidate of candidates) {
    if (plan.tasks.length >= llm.budget.maxItemsPerRun) {
      plan.cappedByItems++
      continue
    }
    const input = cut(candidate.item.excerpt ?? '', llm.budget.maxInputCharsPerItem)
    // A full-text task books its per-item ceiling up front rather than the excerpt it
    // starts with. Reserving keeps the plan a pure function — `--llm-dry-run` promises the
    // same item list the run will make — and it can only over-reserve: the article arrives
    // cut to that same ceiling, or it does not arrive and the excerpt costs less.
    const wantsFullText = candidate.policy.fetchFullText
    const reservedChars = wantsFullText
      ? Math.max(input.length, llm.budget.maxInputCharsPerItem)
      : input.length
    if (plan.inputChars + reservedChars > llm.budget.maxTotalInputChars) {
      plan.cappedByChars++
      continue
    }
    plan.inputChars += reservedChars
    plan.tasks.push({
      item: candidate.item,
      sectionId: candidate.sectionId,
      policy: candidate.policy,
      input,
      // The archive records what was actually sent, so this stays `excerpt` until the
      // fetch comes back with something better.
      inputKind: 'excerpt',
      wantsFullText,
      reservedChars,
      estimatedInputTokens:
        estimateTokens(candidate.item.title) +
        (wantsFullText
          ? reservedTokens(candidate.item.title, reservedChars)
          : estimateTokens(input)),
    })
  }

  return plan
}
