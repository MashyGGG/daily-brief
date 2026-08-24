import { describe, expect, it } from 'vitest'
import { createJuejinPublisher, JUEJIN_ENDPOINTS, parseEnvelope } from '../src/publish/juejin'
import { publishAll } from '../src/publish/index'
import { publishTargetSchema, type PublishTarget } from '../src/config/schema'
import type { PlatformArticle, PublisherContext } from '../src/publish/types'

const COOKIE = 'sessionid=SUPERSECRETSESSION; other=1'

interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function harness(responses: Array<{ status?: number; body: unknown; raw?: string }>) {
  const calls: Call[] = []
  let at = 0
  const ctx: PublisherContext = {
    env: { JUEJIN_COOKIE: COOKIE },
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        headers: init?.headers ?? {},
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      })
      const next = responses[Math.min(at++, responses.length - 1)]!
      return {
        ok: (next.status ?? 200) < 400,
        status: next.status ?? 200,
        text: async () => next.raw ?? JSON.stringify(next.body),
      }
    },
  }
  return { ctx, calls }
}

const target = (over: Record<string, unknown> = {}): PublishTarget =>
  publishTargetSchema.parse({
    id: 'juejin',
    platform: 'juejin',
    secretRef: 'JUEJIN_COOKIE',
    autoPublish: false,
    juejin: { categoryId: 'C1', tagIds: ['T1', 'T2'] },
    ...over,
  })

const article = (over: Partial<PlatformArticle> = {}): PlatformArticle => ({
  scheduleId: 'daily',
  publishDate: '2026-08-22',
  title: '技术日报',
  markdown: '## 国际技术\n\n1. [T](https://e.com/1)\n',
  brief: '摘要'.repeat(80),
  tags: ['前端'],
  canonicalUrl: 'https://x.dev/a.html',
  contentHash: 'HASH',
  ...over,
})

describe('publish/juejin — the draft never publishes itself', () => {
  /**
   * PUBLISH.md §9 — the single most important test in this feature. Stage A of §6.5 is
   * built entirely on "the draft stays in the 草稿箱 until a human has looked at it".
   */
  it('never calls article/publish while autoPublish is off', async () => {
    const { ctx, calls } = harness([{ body: { err_no: 0, data: { id: '7541' } } }])
    const outcomes = await publishAll(
      [{ target: target(), resolved: target(), article: article() }],
      { ctx },
    )
    expect(outcomes[0]!.result.status).toBe('created')
    expect(calls.map((c) => c.url)).toEqual([JUEJIN_ENDPOINTS.createDraft])
    expect(calls.some((c) => c.url === JUEJIN_ENDPOINTS.publish)).toBe(false)
  })

  it('calls article/publish only once autoPublish is on', async () => {
    const t = target({ autoPublish: true })
    const { ctx, calls } = harness([
      { body: { err_no: 0, data: { id: '7541' } } },
      { body: { err_no: 0, data: { article_id: '999' } } },
    ])
    const outcomes = await publishAll([{ target: t, resolved: t, article: article() }], { ctx })
    expect(outcomes[0]!.result.status).toBe('published')
    expect(calls.map((c) => c.url)).toEqual([
      JUEJIN_ENDPOINTS.createDraft,
      JUEJIN_ENDPOINTS.publish,
    ])
    expect(outcomes[0]!.result.url).toBe('https://juejin.cn/post/999')
  })
})

describe('publish/juejin — the request', () => {
  it('sends markdown, the configured category and tags, and a capped teaser', async () => {
    const { ctx, calls } = harness([{ body: { err_no: 0, data: { id: '7541' } } }])
    const draft = await createJuejinPublisher(ctx).createDraft(article(), target())

    const body = calls[0]!.body
    expect(body.edit_type).toBe(10) // markdown, not the rich-text editor
    expect(body.category_id).toBe('C1')
    expect(body.tag_ids).toEqual(['T1', 'T2'])
    expect(body.mark_content).toContain('## 国际技术')
    expect([...(body.brief_content as string)].length).toBeLessThanOrEqual(100)
    // The draft URL is written into the state precisely so a human can open and review it.
    expect(draft.url).toBe('https://juejin.cn/editor/drafts/7541')
  })

  it('sends the cookie and a browser-shaped set of headers', async () => {
    const { ctx, calls } = harness([{ body: { err_no: 0, data: { id: '1' } } }])
    await createJuejinPublisher(ctx).createDraft(article(), target())
    expect(calls[0]!.headers.cookie).toBe(COOKIE)
    expect(calls[0]!.headers.referer).toBe('https://juejin.cn/')
    expect(calls[0]!.headers['user-agent']).toMatch(/Mozilla/)
  })

  it('passes the draft id on update rather than creating a second article', async () => {
    const { ctx, calls } = harness([{ body: { err_no: 0, data: { id: '7541' } } }])
    await createJuejinPublisher(ctx).updateDraft('7541', article(), target())
    expect(calls[0]!.url).toBe(JUEJIN_ENDPOINTS.updateDraft)
    expect(calls[0]!.body.id).toBe('7541')
  })
})

describe('publish/juejin — failure modes (§8)', () => {
  it('treats a non-zero err_no as a failure even though HTTP said 200', () => {
    expect(() => parseEnvelope('{"err_no":403,"err_msg":"forbidden"}')).toThrow(/err_no 403/)
    expect(() => parseEnvelope('{"err_no":0,"data":{"id":"1"}}')).not.toThrow()
  })

  it('names the expired cookie when the answer is a login page rather than JSON', async () => {
    const { ctx } = harness([{ raw: '<!DOCTYPE html><html>login</html>', body: null }])
    await expect(createJuejinPublisher(ctx).createDraft(article(), target())).rejects.toThrow(
      /Cookie/,
    )
  })

  it('names the expired cookie on a 401', async () => {
    const { ctx } = harness([{ status: 401, body: {} }])
    await expect(createJuejinPublisher(ctx).createDraft(article(), target())).rejects.toThrow(
      /过期/,
    )
  })

  it('never puts the cookie into a thrown error — this repo is public', async () => {
    const { ctx } = harness([{ status: 500, body: { err_msg: `rejected for ${COOKIE}` } }])
    await expect(createJuejinPublisher(ctx).createDraft(article(), target())).rejects.toSatisfy(
      (err: unknown) => !(err as Error).message.includes('SUPERSECRETSESSION'),
    )
  })

  it('reports a missing cookie as a skip, not a failure', () => {
    const ctx: PublisherContext = {
      env: {},
      sleep: async () => {},
      fetchImpl: async () => {
        throw new Error('must not be called')
      },
    }
    expect(createJuejinPublisher(ctx).missingEnv(target())).toEqual(['JUEJIN_COOKIE'])
  })
})
