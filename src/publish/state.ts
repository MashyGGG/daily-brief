import type { PublishTarget } from '../config/schema'
import { nodeFs, type FsLike } from '../archive/fs'
import { archiveNames } from '../archive/paths'
import { redactDeep } from '../core/redact'
import type { CollectedIssue, PlatformArticle } from './types'

/**
 * PUBLISH.md §4 — idempotency.
 *
 * An article no longer corresponds one-to-one to an archived issue (§1.3), so the state's
 * primary key is **publication date + publishing line**, not the archive filename. It
 * lives next to the content it was built from:
 *
 *   archive/2026/08/2026-08-25.morning.json   the brief's own record (existing)
 *   archive/2026/08/2026-08-25.publish.json   every line's publish state (new)
 *
 * `itemIds` holds ids only, never whole items: the content is already in the archive
 * JSON next to it, and a second copy is a second truth.
 */

/** What the platform currently holds. `draft` is 掘金's 草稿箱; Notion has no draft state. */
export type StoredStatus = 'draft' | 'published' | 'failed'

export interface TargetState {
  platform: string
  status: StoredStatus
  postId?: string
  url?: string
  contentHash?: string
  attempts: number
  /** Consecutive failures. Reset on any success; `failStreakLimit` trips on it (§8). */
  failStreak: number
  updatedAt: string
  /** Redacted before it is ever written — this repo is public. */
  lastError?: string | null
}

export interface LineState {
  sources: Array<{ date: string; slot: string | null }>
  itemCount: number
  /** The only basis for cross-publication dedupe (§4.1). */
  itemIds: string[]
  contentHash: string
  targets: Record<string, TargetState>
}

export interface PublishState {
  publishDate: string
  lines: Record<string, LineState>
}

export function statePath(baseDir: string, date: string): string {
  return archiveNames(baseDir, date, 'publish').json
}

/**
 * A corrupt state file is treated as "no record", not as a crash. The alternative is a
 * single bad write permanently wedging the whole publishing line; the cost of being
 * wrong here is at worst one duplicate article, which `contentHash` still usually stops.
 */
export function parseState(text: string | null): PublishState | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as PublishState
    if (!parsed || typeof parsed.publishDate !== 'string' || typeof parsed.lines !== 'object') {
      return null
    }
    return { publishDate: parsed.publishDate, lines: parsed.lines ?? {} }
  } catch {
    return null
  }
}

export function readState(baseDir: string, date: string, fs: FsLike = nodeFs): PublishState | null {
  return parseState(fs.readFile(statePath(baseDir, date)))
}

export function writeState(
  baseDir: string,
  state: PublishState,
  fs: FsLike = nodeFs,
  secretValues?: string[],
): void {
  // §4.1 — `lastError` can carry a fragment of a Cookie or a signed URL, and this file is
  // committed to a PUBLIC repo. Same rule as the archived warnings (A16).
  const safe = redactDeep(state, secretValues)
  fs.writeFile(statePath(baseDir, state.publishDate), JSON.stringify(safe, null, 2) + '\n')
}

/**
 * Every item id any publication has already carried, over the last `days` days.
 *
 * This is what stops backfill (§1.3 step 6) from re-picking items that went out in an
 * earlier publication — the one duplication the pipeline's own cross-day dedupe does not
 * cover, because it works per archived issue rather than per publication.
 */
export function publishedItemIds(
  baseDir: string,
  dates: string[],
  fs: FsLike = nodeFs,
): Set<string> {
  const ids = new Set<string>()
  for (const date of dates) {
    const state = readState(baseDir, date, fs)
    if (!state) continue
    for (const line of Object.values(state.lines)) {
      for (const id of line.itemIds ?? []) ids.add(id)
    }
  }
  return ids
}

/* ─────────────────────────── §4.2 the decision table ─────────────────────────── */

export type PublishAction = 'create' | 'update' | 'skip' | 'halt'

export interface Decision {
  action: PublishAction
  /** Present for `update`; the post to edit. */
  postId?: string
  /** One line, printed in the summary and stored as the result's detail. */
  reason: string
  /** Worth an alert even though nothing failed (published content diverged, circuit open). */
  warn?: boolean
}

export interface DecideOptions {
  target: PublishTarget
  article: Pick<PlatformArticle, 'contentHash'>
  state?: TargetState
  /** `--force`: ignore the hash comparison and edit anyway. */
  force?: boolean
  /**
   * Can this platform edit something already public without making it worse?
   * Notion is a private mirror, so yes. 掘金 is a public timeline, so no (§4.2).
   */
  editablePublished: boolean
}

export function decide(options: DecideOptions): Decision {
  const { target, article, state, force, editablePublished } = options

  if (!state || !state.postId) {
    if (state && state.failStreak >= target.failStreakLimit && !force) {
      return {
        action: 'halt',
        reason:
          `circuit open: ${state.failStreak} consecutive failures (limit ` +
          `${target.failStreakLimit}) — fix the cause, then re-run with --force`,
        warn: true,
      }
    }
    return { action: 'create', reason: state ? 'retrying the initial create' : 'first publication' }
  }

  if (state.status === 'failed' && state.failStreak >= target.failStreakLimit && !force) {
    return {
      action: 'halt',
      postId: state.postId,
      reason:
        `circuit open: ${state.failStreak} consecutive failures (limit ` +
        `${target.failStreakLimit}) — fix the cause, then re-run with --force`,
      warn: true,
    }
  }

  if (force) {
    return { action: 'update', postId: state.postId, reason: '--force: updating regardless' }
  }

  const unchanged = state.contentHash === article.contentHash

  if (state.status === 'failed') {
    return {
      action: 'update',
      postId: state.postId,
      reason: `retrying after failure ${state.failStreak}/${target.failStreakLimit}`,
    }
  }

  if (unchanged) {
    // The foundation of the whole design: re-running the workflow costs nothing.
    return { action: 'skip', postId: state.postId, reason: 'unchanged since the last run' }
  }

  if (state.status === 'published' && !editablePublished) {
    // Already on a public timeline. Silently rewriting it is worse than leaving it: the
    // readers who saw it are not going to be told, and the platform records an edit.
    return {
      action: 'skip',
      postId: state.postId,
      reason: 'selection changed but the post is already public — not editing it silently',
      warn: true,
    }
  }

  return { action: 'update', postId: state.postId, reason: 'selection changed since the last run' }
}

/** The state a successful attempt leaves behind. */
export function afterSuccess(
  previous: TargetState | undefined,
  next: {
    platform: string
    status: StoredStatus
    postId: string
    url?: string
    contentHash: string
    at: string
  },
): TargetState {
  return {
    platform: next.platform,
    status: next.status,
    postId: next.postId,
    ...(next.url ? { url: next.url } : {}),
    contentHash: next.contentHash,
    attempts: (previous?.attempts ?? 0) + 1,
    failStreak: 0,
    updatedAt: next.at,
    lastError: null,
  }
}

/** The state a failed attempt leaves behind — `failStreak` is what trips the circuit. */
export function afterFailure(
  previous: TargetState | undefined,
  next: { platform: string; error: string; at: string },
): TargetState {
  return {
    platform: next.platform,
    status: 'failed',
    ...(previous?.postId ? { postId: previous.postId } : {}),
    ...(previous?.url ? { url: previous.url } : {}),
    ...(previous?.contentHash ? { contentHash: previous.contentHash } : {}),
    attempts: (previous?.attempts ?? 0) + 1,
    failStreak: (previous?.failStreak ?? 0) + 1,
    updatedAt: next.at,
    lastError: next.error,
  }
}

/** Fold one line's result into the state document, creating the containers as needed. */
export function upsertLine(
  state: PublishState | null,
  publishDate: string,
  issue: CollectedIssue,
  contentHash: string,
): PublishState {
  const base: PublishState = state ?? { publishDate, lines: {} }
  const previous = base.lines[issue.scheduleId]
  return {
    ...base,
    publishDate,
    lines: {
      ...base.lines,
      [issue.scheduleId]: {
        sources: issue.sources,
        itemCount: issue.itemIds.length,
        itemIds: issue.itemIds,
        contentHash,
        targets: previous?.targets ?? {},
      },
    },
  }
}

export function setTargetState(
  state: PublishState,
  lineId: string,
  targetId: string,
  target: TargetState,
): PublishState {
  const line = state.lines[lineId]
  if (!line) return state
  return {
    ...state,
    lines: {
      ...state.lines,
      [lineId]: { ...line, targets: { ...line.targets, [targetId]: target } },
    },
  }
}
