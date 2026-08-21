import type { BriefDigest, DigestConfig, LlmConfig } from '../config/schema'
import type { BriefSection } from '../core/brief'
import type { LlmClient } from './llm'
import { cut, estimateTokens } from './policy'
import { DIGEST_PROMPT_VERSION, digestSystemPrompt, digestUserPrompt } from './prompt'
import type { DigestEntry } from './prompt'
import { sanitizeDigest } from './sanitize'

/**
 * §9 M3 — 全刊导读: one call that reads the issue this run just built and says what is
 * worth the reader's morning.
 *
 * It is the cheapest thing in this milestone and the most visible: fixed at one call, no
 * fetch of its own, and it is the first thing on the page. It runs LAST on purpose —
 * after the item summaries have landed — because the whole point is that it summarizes
 * the issue the reader is about to get, not the raw feeds it was assembled from.
 */

/**
 * What the digest is allowed to see: title plus whatever body the item ended up with
 * (the LLM summary where there is one, the source excerpt otherwise), both cut to
 * `maxCharsPerItem`, and only the first `maxItems` in section order.
 *
 * Pure, so the token estimate `--llm-dry-run` prints is the one the real run will spend.
 */
export function buildDigestEntries(sections: BriefSection[], config: DigestConfig): DigestEntry[] {
  const entries: DigestEntry[] = []
  for (const section of sections) {
    for (const item of section.items) {
      if (entries.length >= config.maxItems) return entries
      entries.push({
        section: section.title,
        title: cut(item.title, config.maxCharsPerItem),
        body: cut(item.summary ?? item.excerpt ?? '', config.maxCharsPerItem),
      })
    }
  }
  return entries
}

/** Display-only, and the only number `--llm-dry-run` can offer for the digest. */
export function estimateDigestTokens(entries: DigestEntry[]): number {
  return entries.reduce((n, e) => n + estimateTokens(e.title) + estimateTokens(e.body) + 2, 0)
}

export interface DigestOutcome {
  digest: BriefDigest | null
  attempts: number
  promptTokens: number
  completionTokens: number
  /** Empty when it worked; otherwise the (already-redacted) reason it did not. */
  failure: string | null
}

const NONE: DigestOutcome = {
  digest: null,
  attempts: 0,
  promptTokens: 0,
  completionTokens: 0,
  failure: null,
}

/**
 * One call, isolated exactly like `summarizeOne`: a failure here costs the issue its
 * opening paragraph and nothing else — every item still carries its own summary, and
 * §6.1 says the exit code never learns about any of this.
 */
export async function generateDigest(
  sections: BriefSection[],
  llm: LlmConfig,
  client: LlmClient,
  describeError: (err: unknown) => string,
): Promise<DigestOutcome> {
  const entries = buildDigestEntries(sections, llm.digest)
  if (entries.length === 0) return NONE

  try {
    const result = await client.complete(
      digestSystemPrompt({
        sentences: llm.digest.sentences,
        maxChars: llm.digest.maxChars,
        language: llm.defaults.language,
      }),
      digestUserPrompt(entries),
    )
    const text = sanitizeDigest(result.content, llm.digest.maxChars)
    if (!text) {
      return { ...NONE, attempts: result.attempts, failure: 'model returned nothing usable' }
    }
    return {
      digest: {
        text,
        meta: {
          by: 'llm',
          model: client.model,
          promptVersion: DIGEST_PROMPT_VERSION,
          // Not `excerpt` and not `fulltext`: the digest reads the finished issue.
          inputKind: 'summaries',
        },
      },
      attempts: result.attempts,
      promptTokens: result.usage?.promptTokens ?? 0,
      completionTokens: result.usage?.completionTokens ?? 0,
      failure: null,
    }
  } catch (err) {
    return { ...NONE, attempts: 1, failure: describeError(err) }
  }
}
