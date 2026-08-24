import { describe, expect, it } from 'vitest'
import { createNotionPublisher } from '../src/publish/notion'
import { publishTargetSchema, type PublishTarget } from '../src/config/schema'
import type { PlatformArticle, PublisherContext } from '../src/publish/types'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** A fake fetch. No test in this repo ever opens a socket. */
function harness(
  responses: Array<{ status?: number; body: unknown }>,
  env: NodeJS.ProcessEnv = { NOTION_TOKEN: 'ntn_secret', NOTION_DATA_SOURCE_ID: 'ds-1' },
) {
  const calls: Call[] = []
  let at = 0
  const ctx: PublisherContext = {
    env,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers ?? {},
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      })
      const next = responses[Math.min(at++, responses.length - 1)]!
      return {
        ok: (next.status ?? 200) < 400,
        status: next.status ?? 200,
        text: async () => JSON.stringify(next.body),
      }
    },
  }
  return { ctx, calls }
}

const target = (over: Record<string, unknown> = {}): PublishTarget =>
  publishTargetSchema.parse({
    id: 'notion-archive',
    platform: 'notion',
    secretRef: 'NOTION_TOKEN',
    autoPublish: true,
    notion: { dataSourceRef: 'NOTION_DATA_SOURCE_ID', pageRef: '' },
    ...over,
  })

const article = (over: Partial<PlatformArticle> = {}): PlatformArticle => ({
  scheduleId: 'daily',
  publishDate: '2026-08-22',
  title: '每日早报 · 技术日报（2026-08-22）',
  markdown: '## 国际技术\n\n1. [T](https://e.com/1)\n',
  brief: '三句话摘要',
  tags: ['前端', 'AI'],
  canonicalUrl: 'https://x.dev/2026/08/2026-08-22.evening.html',
  contentHash: 'HASH',
  ...over,
})

describe('publish/notion — the request sequence (§5.1)', () => {
  it('pins the API version rather than following latest', async () => {
    const { ctx, calls } = harness([
      { body: { data_sources: [{ id: 'ds-real' }] } },
      { body: { id: 'p1', url: 'https://notion.so/p1' } },
    ])
    await createNotionPublisher(ctx).createDraft(article(), target())
    expect(calls.every((c) => c.headers['Notion-Version'] === '2025-09-03')).toBe(true)
    expect(calls[0]!.headers.authorization).toBe('Bearer ntn_secret')
  })

  it('resolves database → data_source once, not per article', async () => {
    const { ctx, calls } = harness([
      { body: { data_sources: [{ id: 'ds-real' }] } },
      { body: { id: 'p1' } },
    ])
    const publisher = createNotionPublisher(ctx)
    await publisher.createDraft(article(), target())
    await publisher.createDraft(article({ contentHash: 'H2' }), target())

    const lookups = calls.filter((c) => c.url.includes('/databases/'))
    expect(lookups).toHaveLength(1)
    const creates = calls.filter((c) => c.url.endsWith('/pages'))
    expect(creates).toHaveLength(2)
    expect(creates[0]!.body.parent).toEqual({ data_source_id: 'ds-real' })
    expect(creates[1]!.body.parent).toEqual({ data_source_id: 'ds-real' })
  })

  it('maps every configured property (§5.4)', async () => {
    const { ctx, calls } = harness([
      { body: { data_sources: [{ id: 'ds' }] } },
      { body: { id: 'p1' } },
    ])
    await createNotionPublisher(ctx).createDraft(article(), target())
    const props = calls.at(-1)!.body.properties as Record<string, Record<string, unknown>>
    expect(props.Name!.title).toBeDefined()
    expect(props.Date!.date).toEqual({ start: '2026-08-22' })
    expect(props.Line!.select).toEqual({ name: 'daily' })
    expect(props.Tags!.multi_select).toEqual([{ name: '前端' }, { name: 'AI' }])
    expect(props.Source!.url).toBe('https://x.dev/2026/08/2026-08-22.evening.html')
  })

  it('appends the overflow serially, ≤100 children per request', async () => {
    const long = Array.from({ length: 250 }, (_, i) => `- item ${i}`).join('\n')
    const { ctx, calls } = harness([
      { body: { data_sources: [{ id: 'ds' }] } },
      { body: { id: 'p1' } },
    ])
    await createNotionPublisher(ctx).createDraft(article({ markdown: long }), target())

    const create = calls.find((c) => c.url.endsWith('/pages'))!
    expect((create.body.children as unknown[]).length).toBe(100)
    const appends = calls.filter((c) => c.url.includes('/blocks/p1/children'))
    expect(appends).toHaveLength(2)
    expect((appends[0]!.body.children as unknown[]).length).toBe(100)
    expect((appends[1]!.body.children as unknown[]).length).toBe(50)
  })

  it('uses page mode without touching the data-source machinery', async () => {
    const { ctx, calls } = harness([{ body: { id: 'p1' } }], {
      NOTION_TOKEN: 't',
      NOTION_PAGE_ID: 'parent-page',
    })
    await createNotionPublisher(ctx).createDraft(
      article(),
      target({
        notion: { dataSourceRef: '', pageRef: 'NOTION_PAGE_ID' },
      }),
    )
    expect(calls.some((c) => c.url.includes('/databases/'))).toBe(false)
    expect(calls[0]!.body.parent).toEqual({ page_id: 'parent-page' })
  })
})

describe('publish/notion — errors and update', () => {
  it('surfaces a property-name mismatch verbatim: the message IS the fix', async () => {
    const { ctx } = harness([
      {
        status: 400,
        body: { code: 'validation_error', message: 'Summary is not a property that exists' },
      },
    ])
    await expect(
      createNotionPublisher(ctx).createDraft(
        article(),
        target({
          notion: { dataSourceRef: '', pageRef: 'NOTION_PAGE_ID' },
        }),
      ),
    ).rejects.toThrow('Summary is not a property that exists')
  })

  it('does not retry a validation error — it would only delay the alert', async () => {
    const { ctx, calls } = harness([
      { status: 400, body: { code: 'validation_error', message: 'nope' } },
    ])
    await expect(
      createNotionPublisher(ctx).createDraft(
        article(),
        target({
          notion: { dataSourceRef: '', pageRef: 'NOTION_PAGE_ID' },
        }),
      ),
    ).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('retries a 429 with backoff', async () => {
    const { ctx, calls } = harness([{ status: 429, body: { message: 'rate limited' } }])
    await expect(
      createNotionPublisher(ctx).createDraft(
        article(),
        target({
          notion: { dataSourceRef: '', pageRef: 'NOTION_PAGE_ID' },
        }),
      ),
    ).rejects.toThrow(/rate limited/)
    expect(calls).toHaveLength(4) // one try + three retries
  })

  it('updates the properties only, and says so (§5.3)', async () => {
    const { ctx, calls } = harness([{ body: { id: 'p1' } }])
    const result = await createNotionPublisher(ctx).updateDraft('p1', article(), target())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/pages/p1')
    expect(calls[0]!.method).toBe('PATCH')
    // No block listing, no deletes: a half-deleted page is worse than a stale one.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(result?.detail).toMatch(/正文未同步/)
  })

  it('reports a missing token or parent id as a skip, not a failure', () => {
    const { ctx } = harness([{ body: {} }], {})
    expect(createNotionPublisher(ctx).missingEnv(target())).toEqual([
      'NOTION_TOKEN',
      'NOTION_DATA_SOURCE_ID',
    ])
  })
})
