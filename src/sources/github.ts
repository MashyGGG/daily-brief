import type { RawItem, Source } from '../config/schema'
import { normalize } from '../core/normalize'
import { httpGetJson, type FetchContext } from './types'

type GhSource = Extract<Source, { type: 'github' }>

/**
 * §0.6 — GitHub has no official Trending API and we never scrape the HTML page.
 * The equivalent is a repository search over recently created repos sorted by stars.
 */
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

export function parseRepos(repos: GhRepo[], sourceName: string, now: Date): RawItem[] {
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
    )
    if (item) items.push(item)
  }
  return items
}

export async function fetchGithub(source: GhSource, ctx: FetchContext): Promise<RawItem[]> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  // Actions injects GITHUB_TOKEN automatically; it lifts search from 10/min to 30/min.
  const token = ctx.env.GITHUB_TOKEN ?? ctx.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`

  const res = await httpGetJson<GhResponse>(buildGithubUrl(source.params, ctx.now), ctx, headers)
  return parseRepos(res.items ?? [], source.name, ctx.now).slice(0, source.params.limit)
}
