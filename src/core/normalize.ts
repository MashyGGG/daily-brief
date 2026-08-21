import { createHash } from 'node:crypto'
import type { RawItem } from '../config/schema'

export const EXCERPT_MAX = 300

/** Tracking parameters that change nothing about the destination document. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^ref$/i,
  /^ref_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^igshid$/i,
  /^source$/i,
  /^__twitter_impression$/i,
  /^spm$/i,
]

/**
 * Canonical URL used as the dedupe key: scheme-insensitive, host-case-insensitive,
 * `www.` stripped, tracking params dropped, remaining query sorted, trailing slash trimmed.
 */
export function canonicalizeUrl(input: string): string {
  const trimmed = input.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    // Not a parseable URL — fall back to a stable lowercase form.
    return trimmed.toLowerCase().replace(/\/+$/, '')
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.some((re) => re.test(key)))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
  const query = params.map(([k, v]) => `${k}=${v}`).join('&')
  const path = url.pathname.replace(/\/+$/, '')
  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : ''
  return `${host}${port}${path}${query ? `?${query}` : ''}`
}

/** Stable dedupe id derived from the canonical URL. */
export function itemId(url: string): string {
  return createHash('sha256').update(canonicalizeUrl(url)).digest('hex').slice(0, 16)
}

/** Title reduced to a comparable key: case-, punctuation- and whitespace-insensitive. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
}

export function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
      const key = name.toLowerCase()
      if (ENTITIES[key]) return ENTITIES[key]
      if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16))
      if (key.startsWith('#')) return String.fromCodePoint(parseInt(key.slice(1), 10))
      return match
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A feed's fixed noise, compiled once per source. Patterns are validated at config load
 * (`STRIP_PATTERNS` in schema.ts), so anything reaching here already compiles.
 */
export function compileStripPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, 'gi'))
}

/**
 * Remove a source's boilerplate and re-collapse the hole it leaves behind. Applied to the
 * title as well as the excerpt: a shared ` - thepaper.cn` suffix scores higher on the
 * near-duplicate check than a real cross-post does (§`dedupeSchema`).
 *
 * A pattern greedy enough to consume an entire title empties it, and `normalize` then drops
 * the item — that is the intended blast radius of a mis-written pattern: one source, loudly.
 */
export function stripBoilerplate(text: string, patterns: readonly RegExp[]): string {
  let out = text
  // `String.replace` with a /g regex always scans from 0 and resets lastIndex afterwards,
  // so a compiled pattern is safe to reuse across items.
  for (const re of patterns) out = out.replace(re, ' ')
  return out.replace(/\s+/g, ' ').trim()
}

/** Sentence enders. CJK forms are unambiguous; ASCII ones need whitespace behind them. */
const CJK_SENTENCE_END = '。！？…'
const ASCII_SENTENCE_END = '.!?'
/** Punctuation that belongs to the sentence it trails, not to the next one. */
const SENTENCE_CLOSERS = ')]}"\'”’」』）】'
/**
 * How much of the character budget a sentence cut has to fill to be worth taking. Below
 * this, cutting at the sentence throws away more than the tidiness is worth, so we keep
 * the budget and end on an honest ellipsis instead.
 */
const MIN_SENTENCE_FILL = 0.5

/** Whether the ASCII period at `at` closes a dotted abbreviation rather than a sentence. */
function isAbbreviation(chars: readonly string[], at: number): boolean {
  let start = at
  while (start > 0 && /[\p{L}\p{N}]/u.test(chars[start - 1]!)) start--
  const tokenLength = at - start
  return tokenLength === 0 || tokenLength === 1 || chars[start - 1] === '.'
}

/** Index just past the last sentence that fits inside `max`, or 0 when none does. */
function sentenceCut(chars: readonly string[], max: number): number {
  let best = 0
  for (let i = 0; i < Math.min(chars.length, max); i++) {
    const ch = chars[i]!
    const cjk = CJK_SENTENCE_END.includes(ch)
    if (!cjk && !ASCII_SENTENCE_END.includes(ch)) continue
    let end = i + 1
    while (end < chars.length && SENTENCE_CLOSERS.includes(chars[end]!)) end++
    if (end > max) break
    // "v1.2" does not end a sentence: an ASCII period only does when whitespace follows it.
    const next = chars[end]
    if (!cjk && next !== undefined && !/\s/.test(next)) continue
    // "e.g." and "U.S." clear that bar, so also reject a period sitting on a one-letter
    // token — the shape every dotted abbreviation has and no real sentence ending does.
    if (!cjk && isAbbreviation(chars, i)) continue
    best = end
  }
  return best
}

/**
 * §0.1 ② — cut to `max` characters at the last sentence boundary that fits, falling back to
 * a word boundary plus an ellipsis. Counted in code points, so an emoji costs one character
 * rather than splitting into a replacement char.
 */
export function truncate(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text

  const floor = Math.ceil(max * MIN_SENTENCE_FILL)
  const cut = sentenceCut(chars, max)
  if (cut >= floor) return chars.slice(0, cut).join('').trim()

  // No usable sentence break — land the ellipsis between words rather than inside one.
  // CJK has no spaces, so this simply finds nothing there and hard-cuts, as before.
  const head = chars.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  const keep = space >= floor ? head.slice(0, space) : head
  return keep.join('').trimEnd() + '…'
}

/** §3.3 — with no LLM, the excerpt is the source's own description, cleaned and trimmed. */
export function toExcerpt(
  input: string | undefined,
  max = EXCERPT_MAX,
  strip: readonly RegExp[] = [],
): string | undefined {
  if (!input) return undefined
  const text = stripBoilerplate(stripHtml(input), strip)
  if (text === '') return undefined
  return truncate(text, max)
}

/** Parse a source-provided date; fall back to the fetch time when absent or unparseable. */
export function toIsoDate(input: string | number | undefined, fallback: Date): string {
  if (input === undefined || input === null || input === '') return fallback.toISOString()
  if (typeof input === 'number') {
    // HN Algolia returns seconds since epoch.
    const ms = input > 1e12 ? input : input * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? fallback.toISOString() : d.toISOString()
  }
  const d = new Date(input)
  return Number.isNaN(d.getTime()) ? fallback.toISOString() : d.toISOString()
}

export interface NormalizeInput {
  title: string
  url: string
  source: string
  publishedAt?: string | number
  score?: number
  author?: string
  excerpt?: string
}

export interface NormalizeOptions {
  /** Compiled `sources[].stripPatterns` — applied to the title and the excerpt alike. */
  stripPatterns?: readonly RegExp[]
  /** `render.excerptMaxChars`; the config default is `EXCERPT_MAX`. */
  excerptMaxChars?: number
}

/** Any source shape → the §2.1 `RawItem`. Returns null for entries with no title or no URL. */
export function normalize(
  input: NormalizeInput,
  now: Date,
  options: NormalizeOptions = {},
): RawItem | null {
  const strip = options.stripPatterns ?? []
  const title = stripBoilerplate(stripHtml(input.title ?? ''), strip)
  const url = (input.url ?? '').trim()
  if (title === '' || url === '') return null

  const item: RawItem = {
    id: itemId(url),
    title,
    url,
    source: input.source,
    publishedAt: toIsoDate(input.publishedAt, now),
  }
  if (typeof input.score === 'number' && Number.isFinite(input.score)) item.score = input.score
  const author = input.author?.trim()
  if (author) item.author = author
  const excerpt = toExcerpt(input.excerpt, options.excerptMaxChars ?? EXCERPT_MAX, strip)
  if (excerpt) item.excerpt = excerpt
  return item
}
