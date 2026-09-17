import type { RawItem, Source } from '../config/schema'
import { normalize, stripHtml, type NormalizeOptions } from '../core/normalize'
import { httpGetJson, httpGetText, normalizeOptions, type FetchContext } from './types'

type GhSource = Extract<Source, { type: 'github' }>

/** GitHub has no official Trending API; Search is the durable half of the merged signal. */
const SEARCH = 'https://api.github.com/search/repositories'

interface GhRepo {
  full_name: string
  html_url: string
  description?: string | null
  stargazers_count?: number
  created_at?: string
  pushed_at?: string
  owner?: { login?: string }
  language?: string | null
}

interface GhResponse {
  items?: GhRepo[]
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function buildGithubUrl(params: GhSource['params'], now: Date): string {
  const since = new Date(now.getTime() - params.createdWithinDays * 86_400_000)
  const q: string[] = [`created:>${isoDay(since)}`]
  if (params.language) q.push(`language:${params.language}`)
  if (params.minStars > 0) q.push(`stars:>=${params.minStars}`)
  if (params.query) q.push(params.query)

  const search = new URLSearchParams({
    q: q.join(' '),
    sort: 'stars',
    order: 'desc',
    per_page: String(Math.min(params.limit, 100)),
  })
  return `${SEARCH}?${search.toString()}`
}

export function parseRepos(
  repos: GhRepo[],
  sourceName: string,
  now: Date,
  options: NormalizeOptions = {},
): RawItem[] {
  const items: RawItem[] = []
  for (const repo of repos) {
    const language = repo.language ? ` · ${repo.language}` : ''
    const item = normalize(
      {
        title: repo.full_name,
        url: repo.html_url,
        source: sourceName,
        // `created_at` is what the query filtered on, so rank by the same clock.
        publishedAt: repo.created_at,
        score: repo.stargazers_count ?? 0,
        author: repo.owner?.login,
        excerpt: `${repo.description ?? '(no description)'} — ★${repo.stargazers_count ?? 0}${language}`,
      },
      now,
      options,
    )
    if (item) items.push(item)
  }
  return items
}

/** Parse GitHub's server-rendered trending cards. Selector drift returns an empty list. */
export function parseTrending(
  html: string,
  sourceName: string,
  now: Date,
  options: NormalizeOptions = {},
): RawItem[] {
  const out: RawItem[] = []
  for (const block of html.matchAll(/<article\b[\s\S]*?<\/article>/gi)) {
    const body = block[0]
    const repo = /<h2\b[\s\S]*?<a\b[^>]*href=["']\/([^"'?#]+\/[^"'?#]+)["']/i.exec(body)?.[1]
    if (!repo) continue
    const description = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(body)?.[1]
    const starsToday = /([\d,]+)\s+stars?\s+today/i.exec(stripHtml(body))?.[1]
    const item = normalize(
      {
        title: repo.replace(/\s+/g, ''),
        url: `https://github.com/${repo.replace(/\s+/g, '')}`,
        source: sourceName,
        publishedAt: now.toISOString(),
        score: starsToday ? Number(starsToday.replace(/,/g, '')) : undefined,
        excerpt: description,
      },
      now,
      options,
    )
    if (item) out.push(item)
  }
  return out
}

export async function fetchGithub(source: GhSource, ctx: FetchContext): Promise<RawItem[]> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  // Actions injects GITHUB_TOKEN automatically; it lifts search from 10/min to 30/min.
  const token = ctx.env.GITHUB_TOKEN ?? ctx.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`

  const options = normalizeOptions(source, ctx)
  const search = httpGetJson<GhResponse>(buildGithubUrl(source.params, ctx.now), ctx, headers).then(
    (res) => parseRepos(res.items ?? [], source.name, ctx.now, options),
  )
  if (!source.params.includeTrending) return (await search).slice(0, source.params.limit)

  const trendingUrl = source.params.language
    ? `https://github.com/trending/${encodeURIComponent(source.params.language.toLowerCase())}?since=daily`
    : 'https://github.com/trending?since=daily'
  const trending = httpGetText(trendingUrl, ctx, { accept: 'text/html' }).then((html) => {
    const items = parseTrending(html, source.name, ctx.now, options)
    if (items.length === 0)
      throw new Error('GitHub Trending HTML returned 0 parseable repositories')
    return items
  })
  const settled = await Promise.allSettled([trending, search])
  const items = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  if (items.length === 0) {
    throw (settled.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason
  }
  const unique = new Map(items.map((item) => [item.id, item]))
  return [...unique.values()].slice(0, source.params.limit)
}
