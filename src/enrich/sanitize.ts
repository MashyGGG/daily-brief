import { stripHtml, truncate } from '../core/normalize'

/**
 * §6.2 — the model's output goes straight into a public git commit, a GitHub Pages site
 * and your mailbox, with no human in between. A prompt telling it not to emit links is a
 * request; this file is the enforcement.
 *
 * Everything here is a pure function of the string, so a hostile feed cannot arrange for
 * the cleaning to be skipped.
 */

/**
 * ASCII control characters, which have no business in a one-paragraph summary.
 * `no-control-regex` exists to catch these when they are written by accident; matching
 * them on purpose is the entire point of this line.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

/**
 * Zero-width and bidirectional-override characters. These are the interesting ones: they
 * survive every "looks fine to me" review because they render as nothing, while changing
 * what the reader sees relative to what the bytes say.
 */
const INVISIBLE = /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g

/** ```json … ``` — models wrap JSON in fences even when told not to. */
const CODE_FENCE = /^\s*```[a-z]*\s*|\s*```\s*$/gi

/** `[label](https://…)` and `![alt](…)` — keep the label, drop the target. */
const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g

/**
 * Bare links. Schemes and `www.` are unambiguous; a bare `example.com/path` is stripped
 * too because the path is what makes it a link rather than a company being named. A bare
 * `github.com` with no path stays — deleting it would mangle ordinary prose. The final
 * label has to look like a TLD, so `1.5/2.0` is left alone.
 */
const BARE_URL = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi
const BARE_DOMAIN_PATH = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S*/gi

/** Labels a model prepends when it has been asked for a summary. */
const LEADING_LABEL = /^\s*(?:摘要|概括|总结|要点|summary|tl;?dr)\s*[:：、-]\s*/i

/** Bullet glyphs at the head of a takeaway — the list markup is the renderer's job. */
const LEADING_BULLET = /^\s*(?:[-*•·]|\d+[.)、])\s*/

/**
 * One model-produced string → something safe to commit. Returns `''` when nothing
 * survives, which the caller treats as "no summary" and falls back to the excerpt.
 */
export function sanitizeText(input: string, maxChars: number): string {
  let out = input
    .replace(CODE_FENCE, ' ')
    .replace(MARKDOWN_LINK, '$1')
    .replace(BARE_URL, ' ')
    .replace(BARE_DOMAIN_PATH, ' ')
  out = stripHtml(out)
  out = out.replace(CONTROL, ' ').replace(INVISIBLE, '')
  out = out.replace(LEADING_LABEL, '')
  out = out.replace(/\s+/g, ' ').trim()
  if (out === '') return ''
  return truncate(out, maxChars)
}

/** How many bullets a reader will actually read before skipping to the next headline. */
export const MAX_TAKEAWAYS = 3

export function sanitizeTakeaways(input: unknown, maxChars: number): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const entry of input) {
    if (typeof entry !== 'string') continue
    const clean = sanitizeText(entry.replace(LEADING_BULLET, ''), maxChars)
    if (clean !== '' && !out.includes(clean)) out.push(clean)
    if (out.length === MAX_TAKEAWAYS) break
  }
  return out
}

export interface SanitizedSummary {
  summary: string
  takeaways: string[]
}

/**
 * Models answer with JSON, with JSON inside a code fence, or with prose that happens to
 * contain JSON. Accept all three; a summary is worth one lenient parse, and anything that
 * still does not parse degrades to the excerpt rather than failing the run.
 */
export function parseModelJson(raw: string): { summary?: unknown; takeaways?: unknown } | null {
  const attempt = (text: string) => {
    try {
      const parsed: unknown = JSON.parse(text)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { summary?: unknown; takeaways?: unknown })
        : null
    } catch {
      return null
    }
  }
  const trimmed = raw.replace(CODE_FENCE, '').trim()
  const direct = attempt(trimmed)
  if (direct) return direct
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return attempt(trimmed.slice(start, end + 1))
  return null
}

/**
 * Whole-response cleaning: parse, sanitize, enforce `maxChars`. A model that answers with
 * plain prose instead of JSON still gets used — the prose is the summary — because
 * throwing that away would degrade a usable answer over a formatting detail.
 */
export function sanitizeResponse(raw: string, maxChars: number): SanitizedSummary | null {
  const parsed = parseModelJson(raw)
  if (!parsed) {
    const summary = sanitizeText(raw, maxChars)
    return summary === '' ? null : { summary, takeaways: [] }
  }
  const summary = sanitizeText(typeof parsed.summary === 'string' ? parsed.summary : '', maxChars)
  const takeaways = sanitizeTakeaways(parsed.takeaways, maxChars)
  if (summary === '') {
    // JSON with no usable summary but real takeaways: promote the first one rather than
    // discarding a paid-for answer.
    if (takeaways.length === 0) return null
    return { summary: takeaways[0]!, takeaways: takeaways.slice(1) }
  }
  return { summary, takeaways }
}
