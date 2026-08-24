import type { PublishTarget } from '../config/schema'
import { batchBlocks, markdownToBlocks, richText, type NotionBlock } from './markdown'
import { PublishError, type PlatformArticle, type Publisher, type PublisherContext } from './types'

/**
 * PUBLISH.md §5 — Notion (Tier 1).
 *
 * Every endpoint and constant lives in this block so an API change is one edit.
 *
 * The version is PINNED, not `latest`: 2025-09-03 split a database into
 * database → data source → page and moved the create-page parent from `database_id` to
 * `data_source_id`. Following `latest` means a breaking change arrives as a 400 at
 * 09:30 one morning with no commit to blame.
 */
const API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2025-09-03'
const PLATFORM = 'notion'

/** Notion rate-limits around 3 req/s; appends are serial and paced by this. */
const APPEND_PAUSE_MS = 350
const RETRY_DELAYS_MS = [1000, 3000, 9000]

interface NotionErrorBody {
  code?: string
  message?: string
}

function describe(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as NotionErrorBody
    // §5.4 — a property-name mismatch answers with `validation_error: Summary is not a
    // property that exists`. That sentence IS the fix instruction; wrapping it in our own
    // wording would only make it worse.
    if (body?.message) return `${body.code ?? `HTTP ${status}`}: ${body.message}`
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return `HTTP ${status}: ${text.slice(0, 300)}`
}

export function createNotionPublisher(ctx: PublisherContext): Publisher {
  const log = ctx.log ?? (() => {})
  /** database → data_source resolution is done once per process, never per article. */
  const resolvedParents = new Map<string, string>()

  const request = async (
    path: string,
    init: { method: string; body?: unknown },
    token: string,
  ): Promise<Record<string, unknown>> => {
    let lastError = ''
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const res = await ctx.fetchImpl(`${API}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'content-type': 'application/json',
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
      const text = await res.text()
      if (res.ok) {
        try {
          return JSON.parse(text) as Record<string, unknown>
        } catch {
          return {}
        }
      }
      lastError = describe(res.status, text)
      // 429 and 5xx are the only ones worth repeating: a validation error will fail
      // identically three more times and just delay the alert.
      const retryable = res.status === 429 || res.status >= 500
      if (!retryable || attempt === RETRY_DELAYS_MS.length) break
      await ctx.sleep(RETRY_DELAYS_MS[attempt]!)
    }
    throw new PublishError(PLATFORM, lastError)
  }

  /**
   * §5.1 — the config may name either a data source or the database that contains it.
   * A database id is resolved to its first data source once, and the resolution is
   * logged so "why is it writing there" has an answer.
   */
  const resolveParent = async (
    id: string,
    token: string,
  ): Promise<{ data_source_id: string } | { page_id: string }> => {
    const cached = resolvedParents.get(id)
    if (cached) return { data_source_id: cached }
    try {
      const db = await request(`/databases/${id}`, { method: 'GET' }, token)
      const sources = (db.data_sources ?? []) as Array<{ id?: string }>
      const first = sources[0]?.id
      if (first) {
        resolvedParents.set(id, first)
        log(`[publish] notion: resolved database ${id} → data_source ${first}`)
        return { data_source_id: first }
      }
    } catch {
      // Not a database — then it already is a data source id, which is the common case.
    }
    resolvedParents.set(id, id)
    return { data_source_id: id }
  }

  const propertiesOf = (
    article: PlatformArticle,
    target: PublishTarget,
    inDatabase: boolean,
  ): Record<string, unknown> => {
    const names = target.notion!.properties
    if (!inDatabase) {
      // Page mode has exactly one property, and it must be called `title`.
      return { title: { title: richText(article.title) } }
    }
    return {
      [names.title]: { title: richText(article.title) },
      [names.date]: { date: { start: article.publishDate } },
      [names.line]: { select: { name: article.scheduleId } },
      [names.summary]: { rich_text: richText(article.brief) },
      [names.tags]: { multi_select: article.tags.map((name) => ({ name })) },
      [names.url]: { url: article.canonicalUrl || null },
    }
  }

  const appendRest = async (
    pageId: string,
    batches: NotionBlock[][],
    token: string,
  ): Promise<void> => {
    for (const batch of batches) {
      await request(
        `/blocks/${pageId}/children`,
        { method: 'PATCH', body: { children: batch } },
        token,
      )
      await ctx.sleep(APPEND_PAUSE_MS)
    }
  }

  return {
    name: PLATFORM,

    missingEnv(target) {
      const missing: string[] = []
      if (!ctx.env[target.secretRef]) missing.push(target.secretRef)
      const notion = target.notion
      const ref = notion?.dataSourceRef || notion?.pageRef
      if (ref && !ctx.env[ref]) missing.push(ref)
      return missing
    },

    async createDraft(article, target) {
      const token = ctx.env[target.secretRef]!
      const notion = target.notion!
      const inDatabase = Boolean(notion.dataSourceRef)
      const parentId = ctx.env[inDatabase ? notion.dataSourceRef : notion.pageRef]!
      const parent = inDatabase ? await resolveParent(parentId, token) : { page_id: parentId }

      const batches = batchBlocks(markdownToBlocks(article.markdown))
      const page = await request(
        '/pages',
        {
          method: 'POST',
          body: {
            parent,
            properties: propertiesOf(article, target, inDatabase),
            children: batches[0] ?? [],
          },
        },
        token,
      )
      const postId = String(page.id ?? '')
      if (!postId) throw new PublishError(PLATFORM, 'page created but the response carried no id')
      await appendRest(postId, batches.slice(1), token)
      return { postId, url: typeof page.url === 'string' ? page.url : undefined }
    },

    /**
     * §5.3 — Notion has no "replace the page". Overwriting a body means listing every
     * block and DELETEing them one at a time: a 30-item issue is 150+ requests, half a
     * minute serial, and a failure halfway leaves HALF A PAGE. For a private archive
     * mirror that is strictly worse than a page whose body is a few items stale, so the
     * update path syncs the properties and says plainly that it did not touch the body.
     */
    async updateDraft(postId, article, target) {
      const token = ctx.env[target.secretRef]!
      const inDatabase = Boolean(target.notion!.dataSourceRef)
      await request(
        `/pages/${postId}`,
        { method: 'PATCH', body: { properties: propertiesOf(article, target, inDatabase) } },
        token,
      )
      return { detail: '属性已更新；正文未同步（内容已变更，全量重写需 --force，§5.3）' }
    },
  }
}
