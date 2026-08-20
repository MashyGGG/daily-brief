import type { RawItem, Source } from '../config/schema'
import { fetchRss } from './rss'
import { fetchHackerNews } from './hackernews'
import { fetchGithub } from './github'
import type { FetchContext } from './types'

/** type → fetcher registry. Adding a source *type* is one line here; adding a *source* is config only. */
export const FETCHERS = {
  rss: fetchRss,
  hackernews: fetchHackerNews,
  github: fetchGithub,
} as const

export interface SourceOutcome {
  source: string
  items: RawItem[]
  /** Present when the source failed; the run continues without it (A5). */
  error?: string
  /** Newest `publishedAt` this source returned — the input to the staleness check (§3.2). */
  latestPublishedAt?: string
  durationMs: number
}

/** Newest publish date in a batch, or undefined when the batch is empty. */
export function latestPublishedAt(items: RawItem[]): string | undefined {
  let newest: string | undefined
  for (const item of items) {
    if (newest === undefined || item.publishedAt > newest) newest = item.publishedAt
  }
  return newest
}

export type FetchAllOptions = FetchContext & {
  /** Test seam: swap the whole registry out. */
  fetchers?: Partial<Record<Source['type'], (s: never, ctx: FetchContext) => Promise<RawItem[]>>>
  onError?: (source: string, err: unknown) => string
}

/**
 * §3.2 — sources are fetched concurrently and **failure is isolated**: one dead feed
 * records a warning, it never kills the whole brief.
 */
export async function fetchAll(
  sources: Source[],
  options: FetchAllOptions,
): Promise<SourceOutcome[]> {
  const registry = { ...FETCHERS, ...(options.fetchers ?? {}) }
  const started = Date.now()

  return Promise.all(
    sources.map(async (source): Promise<SourceOutcome> => {
      const at = Date.now()
      try {
        const fetcher = registry[source.type] as (
          s: Source,
          ctx: FetchContext,
        ) => Promise<RawItem[]>
        if (!fetcher) throw new Error(`no fetcher registered for type "${source.type}"`)
        const items = await fetcher(source, options)
        return {
          source: source.name,
          items,
          latestPublishedAt: latestPublishedAt(items),
          durationMs: Date.now() - at,
        }
      } catch (err) {
        const message = options.onError
          ? options.onError(source.name, err)
          : err instanceof Error
            ? err.message
            : String(err)
        return {
          source: source.name,
          items: [],
          error: message,
          durationMs: Date.now() - at,
        }
      }
    }),
  ).then((outcomes) => {
    void started
    return outcomes
  })
}

export type { FetchContext, FetchLike } from './types'
