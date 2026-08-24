import type { BriefDigest, PublishTarget } from '../config/schema'
import type { BriefSection } from '../core/brief'
import type { HttpFetch } from '../channels/types'

/**
 * PUBLISH.md §0.1 — `Channel` and `Publisher` are two contracts, not one.
 *
 * A channel sends a message: it has no identity, resending is harmless, and once it is
 * gone it is gone. A publisher creates a RESOURCE — it has an id, resending it means a
 * duplicate article, and changing the content means editing rather than creating a
 * second one. The only thing worth reusing from `src/channels/` is the *orchestration*
 * (`deliver()`'s concurrency + per-target isolation), which `publishAll()` copies.
 */

/**
 * §1.2 — what `collect.ts` produces: the CONTENT of one article, before any platform
 * dialect. Note it is rebuilt from an archive WINDOW, not lifted from one archived
 * issue: "tech only" and "enough items" cannot both be satisfied by a single issue.
 */
export interface CollectedIssue {
  /** Publishing line id: `daily` / `weekly`. */
  scheduleId: string
  /** Publication date (config timezone) — half of the state file's primary key. */
  publishDate: string
  /** Which archived issues it drew from — the footer lists every one of them (§3.4). */
  sources: Array<{ date: string; slot: string | null }>
  /** Already whitelisted by section, deduped across publications, ranked and capped. */
  sections: BriefSection[]
  /** Item ids in this publication, written to state so backfill cannot re-pick them. */
  itemIds: string[]
  /** The digest of the newest issue in the window; absent degrades gracefully (§3.3). */
  digest?: BriefDigest
  /** Human range for `{range}` in the title template. */
  range: string
}

/** §1.2 — one platform-agnostic article. `adapt.ts` produces it; every Publisher eats it. */
export interface PlatformArticle {
  scheduleId: string
  publishDate: string
  title: string
  /** Platform-dialect markdown — NOT the archived copy, see §3.1. */
  markdown: string
  /** The list-page teaser: 掘金's `brief_content`, Notion's `Summary` property. */
  brief: string
  tags: string[]
  /** Where it was published first: the newest source issue's page on GitHub Pages. */
  canonicalUrl: string
  /** Decides update vs skip (§4.3). */
  contentHash: string
}

/** What one attempt did. `skipped` and `failed` mirror `DeliveryStatus`. */
export type PublishStatus = 'created' | 'updated' | 'published' | 'skipped' | 'failed'

export interface PublishResult {
  target: string
  platform: string
  scheduleId: string
  publishDate: string
  status: PublishStatus
  postId?: string
  url?: string
  /** Already redacted — safe to print and to commit. */
  detail?: string
  durationMs: number
}

export interface PublisherContext {
  env: NodeJS.ProcessEnv
  /** Reuses `channels/types.ts`'s `HttpFetch`: tests inject a fake and never go online. */
  fetchImpl: HttpFetch
  sleep: (ms: number) => Promise<void>
  log?: (message: string) => void
}

export interface DraftRef {
  postId: string
  url?: string
}

/**
 * §1.1 — one file per platform, one registry line. Adding a platform must not require
 * touching `types.ts` / `collect.ts` / `state.ts`.
 */
export interface Publisher {
  readonly name: string
  /** Env vars this target needs but does not have. Non-empty = skip, NOT fail (decision 8). */
  missingEnv(target: PublishTarget): string[]
  createDraft(article: PlatformArticle, target: PublishTarget): Promise<DraftRef>
  /** May legitimately leave the body alone; say so in the returned detail (§5.3). */
  updateDraft(
    postId: string,
    article: PlatformArticle,
    target: PublishTarget,
  ): Promise<{ detail?: string; url?: string } | void>
  /**
   * Only ever called when the target's `autoPublish` is on. Notion does not implement it:
   * creating the page already publishes it.
   */
  publish?(postId: string, target: PublishTarget): Promise<{ url?: string }>
}

export class PublishError extends Error {
  constructor(
    readonly platform: string,
    message: string,
  ) {
    super(message)
    this.name = 'PublishError'
  }
}
