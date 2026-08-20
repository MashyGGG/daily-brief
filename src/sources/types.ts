import type { RawItem, Source } from '../config/schema'

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface FetchContext {
  now: Date
  fetchImpl: FetchLike
  env: NodeJS.ProcessEnv
  timeoutMs: number
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

/** One HTTP GET with a timeout; non-2xx becomes an error so the caller can record a warning. */
export async function httpGetText(
  url: string,
  ctx: FetchContext,
  headers: Record<string, string> = {},
): Promise<string> {
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.text()
    if (body.length > MAX_RESPONSE_CHARS) {
      throw new Error(`response too large: ${body.length} chars > ${MAX_RESPONSE_CHARS}`)
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

export async function httpGetJson<T>(
  url: string,
  ctx: FetchContext,
  headers: Record<string, string> = {},
): Promise<T> {
  const text = await httpGetText(url, ctx, { accept: 'application/json', ...headers })
  return JSON.parse(text) as T
}
