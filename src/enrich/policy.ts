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
}

/**
 * The quality gate. An item passes when its own excerpt is NOT already good enough —
 * missing, too short, or matching a known-junk fingerprint — and it is not excluded by
 * the two structural caps.
 *
 * With neither `excerptShorterThan` nor `excerptMatches` configured the excerpt half is
 * off rather than closed: an unconfigured trigger means "don't judge by excerpt", not
 * "reject everything".
 */
export function passesWhen(item: Item, when: LlmConfig['when'], ctx: WhenContext): boolean {
  if (when.topPerSection > 0 && ctx.rankInSection >= when.topPerSection) return false
  if (when.titleLanguageNot && titleLanguage(item.title) === when.titleLanguageNot) return false

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
  /** What actually gets sent, already cut to `budget.maxInputCharsPerItem`. */
  input: string
  inputKind: 'excerpt' | 'fulltext'
  estimatedInputTokens: number
}

export interface EnrichPlan {
  tasks: EnrichTask[]
  /** Items the switches or the quality gate declined — the cheap, intended skips. */
  gated: number
  /** Items a budget ceiling declined, split by which ceiling. Non-zero means retune. */
  cappedByItems: number
  cappedByChars: number
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

function cut(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('')
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
      if (!policy.summarize || !passesWhen(item, llm.when, { rankInSection: rank, junkPatterns })) {
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
    // M1 has only the excerpt to offer; `fetchFullText` is honoured from M2, and
    // `summaryMeta.inputKind` in the archive is what records which one was actually used.
    const input = cut(candidate.item.excerpt ?? '', llm.budget.maxInputCharsPerItem)
    if (plan.inputChars + input.length > llm.budget.maxTotalInputChars) {
      plan.cappedByChars++
      continue
    }
    plan.inputChars += input.length
    plan.tasks.push({
      item: candidate.item,
      sectionId: candidate.sectionId,
      policy: candidate.policy,
      input,
      inputKind: 'excerpt',
      estimatedInputTokens: estimateTokens(candidate.item.title) + estimateTokens(input),
    })
  }

  return plan
}
