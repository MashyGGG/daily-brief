import type { RawItem, Source } from '../config/schema'
import { compileStripPatterns, type NormalizeOptions } from '../core/normalize'

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface FetchContext {
  now: Date
  fetchImpl: FetchLike
  env: NodeJS.ProcessEnv
  timeoutMs: number
  /** `render.excerptMaxChars`; omitted falls back to `EXCERPT_MAX`. */
  excerptMaxChars?: number
  /** Per-source transport retries; configured only for the early/evening tech sources. */
  retries?: number
  /** Test seam for exponential backoff. */
  sleep?: (ms: number) => Promise<void>
  /** Previously observed ids for HTML diff strategies; undefined means first observation. */
  seenIds?: Set<string>
  /** Filled by collectors so the pipeline can persist all observed ids, not only selected ones. */
  observedIds?: Set<string>
}

/**
 * Per-source normalization knobs: that source's own boilerplate patterns plus the run's
 * excerpt budget. Compiled once per fetch rather than once per item.
 */
export function normalizeOptions(source: Source, ctx: FetchContext): NormalizeOptions {
  return {
    stripPatterns: compileStripPatterns(source.stripPatterns),
    excerptMaxChars: ctx.excerptMaxChars,
  }
}

export type Fetcher<S extends Source = Source> = (
  source: S,
  ctx: FetchContext,
) => Promise<RawItem[]>

export class SourceError extends Error {
  constructor(
    readonly sourceName: string,
    message: string,
  ) {
    super(message)
    this.name = 'SourceError'
  }
}

/**
 * Upper bound on a source response, in UTF-16 chars. The largest feed we actually track is
 * kubernetes.io at ~1.2 MB, so this leaves an order of magnitude of headroom while still
 * bounding what reaches the XML parser (see the `processEntities` note in `rss.ts`).
 */
export const MAX_RESPONSE_CHARS = 8 * 1024 * 1024

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(`HTTP ${status}`)
  }
}

/** One HTTP GET with a timeout; non-2xx becomes an error so the caller can record a warning. */
export async function httpGetText(
  url: string,
  ctx: FetchContext,
  headers: Record<string, string> = {},
): Promise<string> {
  const attempts = (ctx.retries ?? 0) + 1
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs)
    try {
      const res = await ctx.fetchImpl(url, {
        headers: {
          'user-agent': 'daily-brief (+https://github.com/MashyGGG/daily-brief)',
          ...headers,
        },
        signal: controller.signal,
      })
      if (!res.ok) {
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500
        throw new HttpStatusError(res.status, retryable)
      }
      const body = await res.text()
      if (body.length > MAX_RESPONSE_CHARS) {
        throw new Error(`response too large: ${body.length} chars > ${MAX_RESPONSE_CHARS}`)
      }
      return body
    } catch (err) {
      lastError = err
      if (err instanceof HttpStatusError && !err.retryable) throw err
      if (attempt + 1 < attempts) {
        await (ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
          250 * 2 ** attempt,
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

export async function httpGetJson<T>(
  url: string,
  ctx: FetchContext,
  headers: Record<string, string> = {},
): Promise<T> {
  const text = await httpGetText(url, ctx, { accept: 'application/json', ...headers })
  return JSON.parse(text) as T
}
