import type { RawItem, Source } from '../config/schema'
import { normalize } from '../core/normalize'
import { httpGetJson, normalizeOptions, type FetchContext } from './types'

type V2exSource = Extract<Source, { type: 'v2ex' }>

interface V2exTopic {
  id: number
  title: string
  url?: string
  content?: string
  content_rendered?: string
  replies?: number
  created?: number
  member?: { username?: string }
}

function parseTopics(topics: V2exTopic[], source: V2exSource, ctx: FetchContext): RawItem[] {
  const options = normalizeOptions(source, ctx)
  return topics.flatMap((topic) => {
    const item = normalize(
      {
        title: topic.title,
        url: topic.url ?? `https://www.v2ex.com/t/${topic.id}`,
        source: source.name,
        publishedAt: topic.created,
        score: topic.replies ?? 0,
        author: topic.member?.username,
        excerpt: topic.content_rendered ?? topic.content,
      },
      ctx.now,
      options,
    )
    return item ? [item] : []
  })
}

async function fetchNode(node: string, source: V2exSource, ctx: FetchContext): Promise<RawItem[]> {
  const token = ctx.env[source.params.tokenRef]
  if (token) {
    try {
      const topics = await httpGetJson<V2exTopic[]>(
        `https://www.v2ex.com/api/v2/nodes/${node}/topics`,
        ctx,
        { authorization: `Bearer ${token}` },
      )
      if (topics.length > 0) return parseTopics(topics, source, ctx)
    } catch {
      // The public v1 endpoint below is the explicit no-token / failed-token fallback.
    }
  }
  const topics = await httpGetJson<V2exTopic[]>(
    `https://www.v2ex.com/api/topics/show.json?node_name=${encodeURIComponent(node)}`,
    ctx,
  )
  return parseTopics(topics, source, ctx)
}

export async function fetchV2ex(source: V2exSource, ctx: FetchContext): Promise<RawItem[]> {
  const settled = await Promise.allSettled(
    source.params.nodes.map((node) => fetchNode(node, source, ctx)),
  )
  const items = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  if (items.length === 0 && settled.some((result) => result.status === 'rejected')) {
    throw (settled.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason
  }
  const unique = new Map(items.map((item) => [item.id, item]))
  return [...unique.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, source.params.limit)
}
