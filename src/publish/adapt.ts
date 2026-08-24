import { createHash } from 'node:crypto'
import type { BriefConfig, PublishSchedule, PublishTarget } from '../config/schema'
import { archiveNames, slotLabel } from '../archive/paths'
import { truncate } from '../core/normalize'
import { renderItemMarkdown } from '../render/markdown'
import type { CollectedIssue, PlatformArticle } from './types'

/**
 * PUBLISH.md §3 — the content adaptation layer.
 *
 * The archived markdown cannot be posted as-is, for three reasons that are all visible
 * to the naked eye on a real platform:
 *
 *   1. `renderArchiveMarkdown` escapes ``` ` [ ] < > _ * \ ``` — 掘金's editor prints the
 *      backslashes literally and Notion carries them into the block text;
 *   2. it carries run metadata (生成时间 / 时段 / ## 告警) written for whoever operates
 *      the job, not for a reader;
 *   3. it has no list-page teaser, no cover, and no absolute links.
 *
 * And there is no archived markdown to lift anyway: what gets published is REBUILT from
 * a window (§1.3), so this module renders it from `CollectedIssue` directly, with the
 * escaper turned off (§3.2).
 */

/** §3.2 — platform markdown wants no backslashes. */
const NO_ESCAPE = (text: string): string => text

/** The teaser cap. 掘金's `brief_content` is short by design; Notion's Summary is a column. */
export const BRIEF_MAX_CHARS = 100

export interface AdaptOptions {
  config: BriefConfig
  schedule: PublishSchedule
  issue: CollectedIssue
  target: PublishTarget
  /** Overrides `publish.canonicalBase`; the workflow passes PUBLISH_CANONICAL_BASE. */
  canonicalBase?: string
  /** `owner/repo`, used to derive the Pages base when nothing else says. */
  repository?: string
}

/**
 * Where this repo publishes first (decision 15). Derived rather than configured so a
 * fork is right by default; `publish.canonicalBase` and PUBLISH_CANONICAL_BASE override
 * it for a custom domain.
 */
export function resolveCanonicalBase(options: {
  configured: string
  override?: string
  repository?: string
}): string {
  const explicit = (options.override || options.configured || '').trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const [owner, repo] = (options.repository ?? '').split('/')
  if (!owner || !repo) return ''
  return `https://${owner.toLowerCase()}.github.io/${repo}`
}

/** The Pages URL of one archived issue — same path the site builder writes (§3.3). */
export function issueUrl(base: string, date: string, slot: string | null): string {
  const { relativeMarkdown } = archiveNames('', date, slot)
  const path = relativeMarkdown.replace(/^\/+/, '').replace(/\.md$/, '.html')
  return base ? `${base}/${path}` : path
}

/** A label a human recognises: `2026-08-22 早报` rather than `2026-08-22.morning`. */
export function sourceLabel(date: string, slot: string | null): string {
  return slot ? `${date} ${slotLabel(slot)}` : date
}

/**
 * §3.4 — the mandatory footer. This is not politeness, it is self-defence: a cross-posted
 * article with no stated provenance is trivially judged as scraped. Saying "automatically
 * compiled · tech items only · here is every source issue and the full archive" makes it
 * what it actually is — an edited digest with a declared editorial line.
 */
export function renderFooter(issue: CollectedIssue, base: string, repoUrl: string): string {
  const sources = issue.sources
    .map((s) => `[${sourceLabel(s.date, s.slot)}](${issueUrl(base, s.date, s.slot)})`)
    .join(' · ')
  const index = base ? `${base}/index.html` : repoUrl
  return [
    '---',
    '',
    `> 本文由 [daily-brief](${repoUrl}) 自动整理，只收录技术条目（新闻栏不外发）。`,
    ...(sources ? [`> 取材：${sources}`] : []),
    `> 完整归档（含未收录栏目）：${index}`,
  ].join('\n')
}

/**
 * §3.3 — the teaser. `digest.text` is already a three-sentence summary of the issue, so
 * it is exactly the right thing when it exists. When it does not — every pre-M3 archive,
 * and any run where the model failed — the fallback is the leading titles, which is
 * duller but never absent. The degraded path is the one that has to be tested.
 */
export function briefFor(issue: CollectedIssue): string {
  if (issue.digest?.text) return truncate(issue.digest.text.trim(), BRIEF_MAX_CHARS)
  const titles = issue.sections
    .flatMap((s) => s.items)
    .slice(0, 5)
    .map((item) => item.title.trim())
    .join('；')
  return truncate(titles, BRIEF_MAX_CHARS)
}

/** `{title}` / `{date}` / `{range}` — nothing else, so a typo shows up as itself. */
export function renderTitle(template: string, values: Record<string, string>): string {
  return template.replace(/\{(title|date|range)\}/g, (_, key: string) => values[key] ?? '')
}

/**
 * §4.3 — the hash covers ONLY what a reader would see change. Not `generatedAt`, not the
 * config hash, not the tags: include a timestamp and every re-run looks like new content
 * and idempotency stops existing; include the tags and re-labelling means re-posting.
 */
export function contentHash(parts: { title: string; brief: string; markdown: string }): string {
  return createHash('sha256')
    .update(`${parts.title}\n${parts.brief}\n${parts.markdown}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * The per-line shallow override (`targets[].overrides.<line>`). Only the keys actually
 * listed win — a weekly that changes its tags must not lose the target's category.
 */
export function resolveTarget(target: PublishTarget, scheduleId: string): PublishTarget {
  const override = target.overrides[scheduleId]
  if (!override) return target
  return {
    ...target,
    ...(override.autoPublish !== undefined ? { autoPublish: override.autoPublish } : {}),
    ...(override.footer !== undefined ? { footer: override.footer } : {}),
    ...(override.notion && target.notion
      ? { notion: { ...target.notion, ...override.notion } }
      : {}),
    ...(override.juejin && target.juejin
      ? { juejin: { ...target.juejin, ...override.juejin } }
      : {}),
  }
}

/** The tags this line puts on this target — the override wins where it says something. */
export function resolveTags(schedule: PublishSchedule, target: PublishTarget): string[] {
  return target.overrides[schedule.id]?.tags ?? schedule.tags
}

/**
 * The body.
 *
 * No leading `# 标题`: the title travels in its own field on both platforms, and 掘金
 * prints the article title above the body — an h1 here would show it twice (§6.4).
 * The digest leads, because a wall of links with no framing is what makes a cross-post
 * read like content farming.
 */
export function renderBody(
  issue: CollectedIssue,
  options: { footer: boolean; base: string; repoUrl: string },
): string {
  const parts: string[] = []
  if (issue.digest?.text) parts.push(`> **导读** ${issue.digest.text.trim()}`)

  for (const section of issue.sections) {
    parts.push(`## ${section.title}`)
    section.items.forEach((item, i) => {
      parts.push(renderItemMarkdown(item, i + 1, { detail: 'full', escape: NO_ESCAPE }))
    })
  }

  if (options.footer) parts.push(renderFooter(issue, options.base, options.repoUrl))
  return parts.join('\n\n') + '\n'
}

export function adapt(options: AdaptOptions): PlatformArticle {
  const { config, schedule, issue } = options
  const target = resolveTarget(options.target, schedule.id)
  const base = resolveCanonicalBase({
    configured: config.publish.canonicalBase,
    override: options.canonicalBase,
    repository: options.repository,
  })
  const repoUrl = options.repository
    ? `https://github.com/${options.repository}`
    : 'https://github.com/'

  const title = renderTitle(schedule.titleTemplate, {
    title: config.title,
    date: issue.publishDate,
    range: issue.range,
  })
  const markdown = renderBody(issue, { footer: target.footer, base, repoUrl })
  const brief = briefFor(issue)

  // The newest source issue is the closest thing to a first-publication page for a
  // window-merged article. It is not a per-item match and the footer says so by listing
  // every source issue — canonical honest rather than canonical convenient (§3.3).
  // `collect` already ordered `sources` chronologically, so this is simply the last one.
  const newest = issue.sources[issue.sources.length - 1]

  return {
    scheduleId: schedule.id,
    publishDate: issue.publishDate,
    title,
    markdown,
    brief,
    tags: resolveTags(schedule, options.target),
    canonicalUrl: newest ? issueUrl(base, newest.date, newest.slot) : base,
    contentHash: contentHash({ title, brief, markdown }),
  }
}
