import type { RawItem, Source } from '../config/schema'
import { normalize, type NormalizeOptions } from '../core/normalize'
import { httpGetJson, normalizeOptions, type FetchContext } from './types'

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

interface FirebaseStory {
  id: number
  title?: string
  url?: string
  score?: number
  by?: string
  time?: number
  descendants?: number
  type?: string
  deleted?: boolean
  dead?: boolean
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

export function parseHnHits(
  hits: AlgoliaHit[],
  sourceName: string,
  now: Date,
  options: NormalizeOptions = {},
): RawItem[] {
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
      options,
    )
    if (item) items.push(item)
  }
  return items
}

export async function fetchHackerNews(source: HnSource, ctx: FetchContext): Promise<RawItem[]> {
  const primary = source.params.provider ?? 'algolia'
  try {
    const items =
      primary === 'firebase' ? await fetchFirebase(source, ctx) : await fetchAlgolia(source, ctx)
    if (items.length > 0 || !source.params.fallbackProvider) return items
    throw new Error(`${primary} returned 0 items`)
  } catch (err) {
    const fallback = source.params.fallbackProvider
    if (!fallback || fallback === primary) throw err
    return fallback === 'firebase' ? fetchFirebase(source, ctx) : fetchAlgolia(source, ctx)
  }
}

async function fetchAlgolia(source: HnSource, ctx: FetchContext): Promise<RawItem[]> {
  const res = await httpGetJson<AlgoliaResponse>(buildHnUrl(source.params), ctx)
  return parseHnHits(res.hits ?? [], source.name, ctx.now, normalizeOptions(source, ctx)).slice(
    0,
    source.params.limit,
  )
}

function firebaseList(mode: HnSource['params']['mode']): string {
  if (mode === 'show_hn') return 'showstories'
  if (mode === 'new') return 'newstories'
  return 'topstories'
}

async function fetchFirebase(source: HnSource, ctx: FetchContext): Promise<RawItem[]> {
  const base = 'https://hacker-news.firebaseio.com/v0'
  const ids = await httpGetJson<number[]>(`${base}/${firebaseList(source.params.mode)}.json`, ctx)
  const candidates = ids.slice(0, Math.min(200, Math.max(source.params.limit * 2, 50)))
  const stories: FirebaseStory[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(8, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const id = candidates[cursor++]!
      const story = await httpGetJson<FirebaseStory>(`${base}/item/${id}.json`, ctx)
      if (story && !story.deleted && !story.dead && story.type === 'story') stories.push(story)
    }
  })
  await Promise.all(workers)
  stories.sort((a, b) => candidates.indexOf(a.id) - candidates.indexOf(b.id))
  return parseHnHits(
    stories.map((story) => ({
      objectID: String(story.id),
      title: story.title,
      url: story.url,
      points: story.score,
      author: story.by,
      created_at: story.time ? new Date(story.time * 1000).toISOString() : undefined,
      num_comments: story.descendants,
    })),
    source.name,
    ctx.now,
    normalizeOptions(source, ctx),
  )
    .filter((item) => (item.score ?? 0) >= source.params.minPoints)
    .slice(0, source.params.limit)
}
