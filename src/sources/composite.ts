import type { RawItem, Source } from '../config/schema'
import { parseFeed } from './rss'
import { parseHtmlProfile } from './html'
import { httpGetText, normalizeOptions, type FetchContext } from './types'

type CompositeSource = Extract<Source, { type: 'composite' }>
type Strategy = CompositeSource['params']['streams'][number]['primary']

async function fetchStrategy(
  strategy: Strategy,
  source: CompositeSource,
  ctx: FetchContext,
): Promise<RawItem[]> {
  const body = await httpGetText(strategy.url, ctx, {
    accept:
      strategy.type === 'rss'
        ? 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8'
        : 'text/html, application/xhtml+xml;q=0.9, */*;q=0.8',
  })
  const options = normalizeOptions(source, ctx)
  const parsed =
    strategy.type === 'rss'
      ? parseFeed(body, source.name, ctx.now, options).slice(0, strategy.limit)
      : parseHtmlProfile(body, strategy, source.name, ctx.now, options)
  if (parsed.length === 0) throw new Error(`${strategy.type} strategy returned 0 parseable items`)
  for (const item of parsed) ctx.observedIds?.add(item.id)
  if (strategy.incremental) {
    // On first observation emit only the newest entry, while persisting the full baseline.
    if (!ctx.seenIds) return parsed.slice(0, 1)
    return parsed.filter((item) => !ctx.seenIds!.has(item.id))
  }
  return parsed
}

async function fetchStream(
  stream: CompositeSource['params']['streams'][number],
  source: CompositeSource,
  ctx: FetchContext,
): Promise<RawItem[]> {
  const errors: string[] = []
  for (const strategy of [stream.primary, ...stream.fallbacks]) {
    try {
      const items = await fetchStrategy(strategy, source, ctx)
      // An incremental stream with no changes succeeded; it must not activate its fallback.
      if (strategy.incremental) return items
      if (items.length === 0) throw new Error(`${strategy.type} strategy returned 0 items`)
      return items
    } catch (err) {
      errors.push(`${strategy.type}:${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(errors.join(' | '))
}

/** Merge complementary streams; fallbacks never become a second logical source/section slot. */
export async function fetchComposite(
  source: CompositeSource,
  ctx: FetchContext,
): Promise<RawItem[]> {
  const settled = await Promise.allSettled(
    source.params.streams.map((stream) => fetchStream(stream, source, ctx)),
  )
  const items = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  if (items.length === 0) {
    const quietIncremental = source.params.streams.every(
      (stream) => stream.primary.incremental === true,
    )
    if (quietIncremental && settled.every((result) => result.status === 'fulfilled')) return []
    const errors = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) =>
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      )
    throw new Error(errors.join(' || ') || 'all composite streams returned 0 items')
  }
  const unique = new Map(items.map((item) => [item.id, item]))
  return [...unique.values()].slice(0, source.params.limit)
}
