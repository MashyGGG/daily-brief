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

/** §3.3 — with no LLM, the excerpt is the source's own description, trimmed. */
export function toExcerpt(input: string | undefined, max = EXCERPT_MAX): string | undefined {
  if (!input) return undefined
  const text = stripHtml(input)
  if (text === '') return undefined
  if ([...text].length <= max) return text
  return [...text].slice(0, max - 1).join('') + '…'
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

/** Any source shape → the §2.1 `RawItem`. Returns null for entries with no title or no URL. */
export function normalize(input: NormalizeInput, now: Date): RawItem | null {
  const title = stripHtml(input.title ?? '').trim()
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
  const excerpt = toExcerpt(input.excerpt)
  if (excerpt) item.excerpt = excerpt
  return item
}
