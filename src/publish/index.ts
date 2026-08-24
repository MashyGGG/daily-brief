import type { PublishPlatform, PublishTarget } from '../config/schema'
import { createNotionPublisher } from './notion'
import { createJuejinPublisher } from './juejin'
import { createStdoutPublisher } from './stdout'
import { decide, type Decision, type TargetState } from './state'
import type {
  PlatformArticle,
  PublishResult,
  Publisher,
  PublisherContext,
  PublishStatus,
} from './types'

/** §1.1 — the registry. One line per platform, exactly like `CHANNELS`. */
export const PUBLISHERS: Record<PublishPlatform, (ctx: PublisherContext) => Publisher> = {
  notion: createNotionPublisher,
  juejin: createJuejinPublisher,
  stdout: createStdoutPublisher,
}

export function createPublisher(platform: PublishPlatform, ctx: PublisherContext): Publisher {
  const factory = PUBLISHERS[platform]
  if (!factory) throw new Error(`unknown publish platform "${platform}"`)
  return factory(ctx)
}

/**
 * §4.2 — can this platform edit something already public without making it worse?
 *
 * Notion is a private archive mirror, so keeping it in sync IS the point. 掘金 is a
 * public timeline: the people who already read it will not be told it changed, so a
 * silent rewrite is worse than a slightly stale post.
 */
const EDITABLE_WHEN_PUBLISHED: Record<PublishPlatform, boolean> = {
  notion: true,
  juejin: false,
  stdout: true,
}

export interface PublishAttempt {
  target: PublishTarget
  /** The target after the per-line shallow override has been applied. */
  resolved: PublishTarget
  article: PlatformArticle
  state?: TargetState
}

export interface PublishAllOptions {
  ctx: PublisherContext
  /** Route everything to stdout: no platform call, no state write. */
  dryRun?: boolean
  /** Ignore the contentHash comparison (`--force`). */
  force?: boolean
  /** Allow the real `publish()` step even where `autoPublish` is off (`--publish`). */
  allowPublish?: boolean
  /** Turns a thrown value into something safe to print and to commit. */
  describeError?: (err: unknown) => string
  /** Called with the state each attempt leaves behind — the caller owns persistence. */
  onResult?: (attempt: PublishAttempt, result: PublishResult, decision: Decision) => void
}

/**
 * §7.5 / §1.1 — one job, `Promise.all`, one try/catch per target.
 *
 * This is `deliver()`'s shape with two additions: consult the state before acting, and
 * report the state afterwards. A `strategy.matrix` job per platform would look natural
 * and then have every job write and push the SAME `*.publish.json` — the isolation a
 * matrix is wanted for is already here, without the concurrent-write problem.
 */
export async function publishAll(
  attempts: PublishAttempt[],
  options: PublishAllOptions,
): Promise<Array<{ attempt: PublishAttempt; result: PublishResult; decision: Decision }>> {
  const describe =
    options.describeError ?? ((err: unknown) => (err instanceof Error ? err.message : String(err)))

  return Promise.all(
    attempts.map(async (attempt) => {
      const at = Date.now()
      const { resolved, article } = attempt
      const base = {
        target: attempt.target.id,
        platform: attempt.target.platform,
        scheduleId: article.scheduleId,
        publishDate: article.publishDate,
      }
      const finish = (
        status: PublishStatus,
        extra: Partial<PublishResult>,
        decision: Decision,
      ): { attempt: PublishAttempt; result: PublishResult; decision: Decision } => {
        const result: PublishResult = { ...base, status, ...extra, durationMs: Date.now() - at }
        options.onResult?.(attempt, result, decision)
        return { attempt, result, decision }
      }

      const skip = (reason: string): ReturnType<typeof finish> =>
        finish('skipped', { detail: reason }, { action: 'skip', reason })

      if (!attempt.target.enabled) return skip('disabled in config')

      try {
        const publisher = options.dryRun
          ? createStdoutPublisher(options.ctx)
          : createPublisher(attempt.target.platform, options.ctx)

        // Decision 8 — a missing secret skips THIS target only: no Notion token must
        // never turn the 掘金 line red.
        const missing = publisher.missingEnv(resolved)
        if (missing.length > 0) return skip(`missing env: ${missing.join(', ')}`)

        const decision = decide({
          target: resolved,
          article,
          state: attempt.state,
          force: options.force,
          editablePublished: EDITABLE_WHEN_PUBLISHED[attempt.target.platform],
        })

        if (decision.action === 'skip' || decision.action === 'halt') {
          return finish(
            'skipped',
            {
              detail: decision.reason,
              ...(decision.postId ? { postId: decision.postId } : {}),
              ...(attempt.state?.url ? { url: attempt.state.url } : {}),
            },
            decision,
          )
        }

        let postId = decision.postId ?? ''
        let url: string | undefined = attempt.state?.url
        let detail = decision.reason
        let status: PublishStatus

        if (decision.action === 'create') {
          const draft = await publisher.createDraft(article, resolved)
          postId = draft.postId
          url = draft.url ?? url
          status = 'created'
        } else {
          const updated = await publisher.updateDraft(postId, article, resolved)
          if (updated?.url) url = updated.url
          if (updated?.detail) detail = `${detail} — ${updated.detail}`
          status = 'updated'
        }

        // Stage A keeps 掘金 in the 草稿箱; `--publish` is the manual escape hatch.
        const mayPublish = resolved.autoPublish || options.allowPublish
        if (mayPublish && publisher.publish) {
          const published = await publisher.publish(postId, resolved)
          if (published.url) url = published.url
          status = 'published'
        } else if (mayPublish && !publisher.publish) {
          // Notion: creating the page already made it visible; there is nothing to call.
          status = 'published'
        }

        return finish(status, { postId, ...(url ? { url } : {}), detail }, decision)
      } catch (err) {
        return finish(
          'failed',
          {
            detail: describe(err),
            ...(attempt.state?.postId ? { postId: attempt.state.postId } : {}),
          },
          { action: 'skip', reason: 'failed' },
        )
      }
    }),
  )
}

export type { Publisher, PublisherContext, PublishResult, PlatformArticle } from './types'
export { PublishError } from './types'
