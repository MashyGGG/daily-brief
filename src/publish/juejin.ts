import { truncate } from '../core/normalize'
import { collectSecretValues, redact } from '../core/redact'
import { PublishError, type Publisher, type PublisherContext } from './types'

/**
 * PUBLISH.md §6 — 掘金 (Tier 2).
 *
 * Said plainly: **掘金 has no official publishing API.** These are the endpoints the web
 * editor calls, authenticated with a browser session cookie. That means no compatibility
 * promise, no deprecation notice, a cookie that expires (roughly 30 days), and a real if
 * small chance that requests from a foreign CI runner look like an anomalous login.
 *
 * The mitigations are all elsewhere: stage A posts drafts only (§6.5), `failStreakLimit`
 * opens a circuit rather than hammering (§8), and `PUBLISH_ENABLED=false` stops
 * everything from a phone (§2.4).
 *
 * ── the constant block ────────────────────────────────────────────────────────────
 * Every endpoint and field name lives here, together, so that the day 掘金 renames one
 * the change is a single edit rather than a search across the file.
 */
const API = 'https://api.juejin.cn/content_api/v1'
const ENDPOINTS = {
  createDraft: `${API}/article_draft/create`,
  updateDraft: `${API}/article_draft/update`,
  publish: `${API}/article/publish`,
} as const
/** `edit_type: 10` = the body is markdown. 掘金 also has a rich-text mode we never want. */
const EDIT_TYPE_MARKDOWN = 10
const DRAFT_URL = 'https://juejin.cn/editor/drafts'
const PLATFORM = 'juejin'

/** 掘金's `brief_content` is a list-page teaser, not a summary field. */
const BRIEF_MAX_CHARS = 100

/**
 * A browser-shaped request. 掘金 answers differently to something that does not look like
 * its own editor, so these headers are load-bearing rather than cosmetic.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36'

interface JuejinEnvelope {
  err_no?: number
  err_msg?: string
  data?: { id?: string; draft_id?: string; article_id?: string } | null
}

/**
 * 掘金 answers HTTP 200 with a business code in the body — the same shape every Chinese
 * push service uses, which is why `channels/types.ts` already has `assertOkCode`. This is
 * that function with 掘金's field names, kept local because the publisher must also read
 * `data` out of the same parse.
 */
export function parseEnvelope(text: string): JuejinEnvelope {
  let parsed: JuejinEnvelope
  try {
    parsed = JSON.parse(text) as JuejinEnvelope
  } catch {
    // A login redirect answers with HTML, not JSON. That is the expired-cookie signature.
    throw new PublishError(
      PLATFORM,
      'response was not JSON — 掘金 Cookie 多半已过期（返回了登录页），去 GitHub Secrets 续 JUEJIN_COOKIE',
    )
  }
  if (typeof parsed.err_no === 'number' && parsed.err_no !== 0) {
    throw new PublishError(
      PLATFORM,
      `掘金 rejected the request (err_no ${parsed.err_no}): ${parsed.err_msg ?? '(no message)'}`,
    )
  }
  return parsed
}

export function createJuejinPublisher(ctx: PublisherContext): Publisher {
  // Belt and braces on top of the redaction `run.ts` does before writing state: a 掘金
  // error body can echo the request back, and an Actions log on a PUBLIC repo is public.
  // The message is scrubbed at the throw site so no caller can leak it by forgetting.
  const secrets = collectSecretValues(ctx.env)
  const fail = (message: string): never => {
    throw new PublishError(PLATFORM, redact(message, secrets))
  }

  const post = async (url: string, cookie: string, payload: unknown): Promise<JuejinEnvelope> => {
    const res = await ctx.fetchImpl(url, {
      method: 'POST',
      headers: {
        // The cookie is the credential. It is read from env and never logged, never
        // written to the state file, and never included in a thrown message (§6.3).
        cookie,
        'content-type': 'application/json',
        'user-agent': UA,
        referer: 'https://juejin.cn/',
        origin: 'https://juejin.cn',
      },
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    if (res.status === 401 || res.status === 403) {
      fail(`HTTP ${res.status} — 掘金 Cookie 已过期或被拒，去 GitHub Secrets 续 JUEJIN_COOKIE`)
    }
    if (!res.ok) fail(`HTTP ${res.status}: ${text.slice(0, 300)}`)
    try {
      return parseEnvelope(text)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }

  return {
    name: PLATFORM,

    missingEnv(target) {
      return ctx.env[target.secretRef] ? [] : [target.secretRef]
    },

    async createDraft(article, target) {
      const cookie = ctx.env[target.secretRef]!
      const juejin = target.juejin!
      const body = await post(ENDPOINTS.createDraft, cookie, {
        category_id: juejin.categoryId,
        tag_ids: juejin.tagIds,
        title: article.title,
        brief_content: truncate(article.brief, BRIEF_MAX_CHARS),
        edit_type: EDIT_TYPE_MARKDOWN,
        html_content: '',
        mark_content: article.markdown,
        link_url: '',
        cover_image: '',
      })
      const postId = body.data?.id ?? body.data?.draft_id ?? ''
      if (!postId) {
        throw new PublishError(PLATFORM, 'draft created but the response carried no draft id')
      }
      // The draft URL goes into the state file precisely so a human can open it and look.
      return { postId, url: `${DRAFT_URL}/${postId}` }
    },

    async updateDraft(postId, article, target) {
      const cookie = ctx.env[target.secretRef]!
      const juejin = target.juejin!
      await post(ENDPOINTS.updateDraft, cookie, {
        id: postId,
        category_id: juejin.categoryId,
        tag_ids: juejin.tagIds,
        title: article.title,
        brief_content: truncate(article.brief, BRIEF_MAX_CHARS),
        edit_type: EDIT_TYPE_MARKDOWN,
        html_content: '',
        mark_content: article.markdown,
      })
      return { url: `${DRAFT_URL}/${postId}` }
    },

    /**
     * Only reached when `autoPublish` is on — `publishAll` is what enforces that, and
     * the test that asserts this endpoint is never touched at `autoPublish: false` is
     * the most important one in the suite (§9).
     */
    async publish(postId, target) {
      const cookie = ctx.env[target.secretRef]!
      const body = await post(ENDPOINTS.publish, cookie, {
        draft_id: postId,
        sync_to_org: target.juejin!.syncToOrg,
      })
      const articleId = body.data?.article_id ?? body.data?.id
      return { url: articleId ? `https://juejin.cn/post/${articleId}` : undefined }
    },
  }
}

export const JUEJIN_ENDPOINTS = ENDPOINTS
export const JUEJIN_EDIT_TYPE_MARKDOWN = EDIT_TYPE_MARKDOWN
