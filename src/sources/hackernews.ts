import type { RawItem, Source } from '../config/schema'
import { normalize } from '../core/normalize'
import { httpGetJson, type FetchContext } from './types'

type HnSource = Extract<Source, { type: 'hackernews' }>

/** §0.6 — HN Algolia, free and unauthenticated. */
const ALGOLIA = 'https://hn.algolia.com/api/v1'

interface AlgoliaHit {
  objectID: string
  title?: string
  story_title?: string
  url?: string | null
  story_url?: string | null
  points?: number
  author?: string
  created_at?: string
  num_comments?: number
}

interface AlgoliaResponse {
  hits: AlgoliaHit[]
}

export function buildHnUrl(params: HnSource['params']): string {
  const search = new URLSearchParams()
  search.set('hitsPerPage', String(Math.min(params.limit, 100)))

  switch (params.mode) {
    case 'front_page':
      search.set('tags', 'front_page')
      return `${ALGOLIA}/search?${search.toString()}`
    case 'show_hn':
      search.set('tags', 'show_hn')
      if (params.minPoints > 0) search.set('numericFilters', `points>${params.minPoints}`)
      return `${ALGOLIA}/search_by_date?${search.toString()}`
    case 'new':
    default:
      search.set('tags', 'story')
      if (params.minPoints > 0) search.set('numericFilters', `points>${params.minPoints}`)
      return `${ALGOLIA}/search_by_date?${search.toString()}`
  }
}

export function parseHnHits(hits: AlgoliaHit[], sourceName: string, now: Date): RawItem[] {
  const items: RawItem[] = []
  for (const hit of hits) {
    const title = hit.title ?? hit.story_title ?? ''
    // Ask HN / text posts have no external URL — link to the discussion instead.
    const url = hit.url ?? hit.story_url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`
    const comments = hit.num_comments ?? 0
    const item = normalize(
      {
        title,
        url,
        source: sourceName,
        publishedAt: hit.created_at,
        score: hit.points ?? 0,
        author: hit.author,
        excerpt: `${hit.points ?? 0} points · ${comments} comments · https://news.ycombinator.com/item?id=${hit.objectID}`,
      },
      now,
    )
    if (item) items.push(item)
  }
  return items
}

export async function fetchHackerNews(source: HnSource, ctx: FetchContext): Promise<RawItem[]> {
  const res = await httpGetJson<AlgoliaResponse>(buildHnUrl(source.params), ctx)
  return parseHnHits(res.hits ?? [], source.name, ctx.now).slice(0, source.params.limit)
}
