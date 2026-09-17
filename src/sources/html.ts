import type { RawItem, Source } from '../config/schema'
import { decodeEntities, normalize, stripHtml, type NormalizeOptions } from '../core/normalize'

type CompositeSource = Extract<Source, { type: 'composite' }>
export type HtmlStrategy = Extract<
  CompositeSource['params']['streams'][number]['primary'],
  { type: 'html' }
>

function absolute(base: string, href: string): string {
  return new URL(decodeEntities(href), base).toString()
}

function links(html: string): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = []
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(re)) {
    const href = match[1]?.trim()
    const text = stripHtml(match[2] ?? '')
    if (href && text) out.push({ href, text })
  }
  return out
}

function linkItems(
  html: string,
  sourceName: string,
  now: Date,
  baseUrl: string,
  accept: (href: string) => boolean,
  dateOf: (href: string, text: string) => string | undefined,
  options: NormalizeOptions,
): RawItem[] {
  const seen = new Set<string>()
  const out: RawItem[] = []
  for (const link of links(html)) {
    if (!accept(link.href)) continue
    const url = absolute(baseUrl, link.href)
    if (seen.has(url)) continue
    seen.add(url)
    const item = normalize(
      {
        title: link.text,
        url,
        source: sourceName,
        publishedAt: dateOf(link.href, link.text),
      },
      now,
      options,
    )
    if (item) out.push(item)
  }
  return out
}

function parseClaudeReleaseNotes(
  html: string,
  sourceName: string,
  now: Date,
  url: string,
  options: NormalizeOptions,
): RawItem[] {
  const out: RawItem[] = []
  const heading = /<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi
  const matches = [...html.matchAll(heading)]
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!
    const title = stripHtml(match[2] ?? '')
      .replace(/[^\p{L}\p{N}, ]+$/u, '')
      .trim()
    if (!/^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(title)) continue
    const attrs = match[1] ?? ''
    const id = /\bid=["']([^"']+)["']/i.exec(attrs)?.[1]
    const start = (match.index ?? 0) + match[0].length
    const end = matches[i + 1]?.index ?? html.length
    const excerpt = stripHtml(html.slice(start, end)).slice(0, 1200)
    const item = normalize(
      {
        title: `Claude Platform updates — ${title}`,
        url: id ? `${url}#${id}` : `${url}#${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        source: sourceName,
        publishedAt: title,
        excerpt,
      },
      now,
      options,
    )
    if (item) out.push(item)
  }
  return out
}

/** Small, explicit parsers for stable list pages. Empty output is a failure to the caller. */
export function parseHtmlProfile(
  html: string,
  strategy: HtmlStrategy,
  sourceName: string,
  now: Date,
  options: NormalizeOptions = {},
): RawItem[] {
  let items: RawItem[]
  switch (strategy.profile) {
    case 'tldr-ai':
    case 'tldr-tech': {
      const channel = strategy.profile === 'tldr-ai' ? 'ai' : 'tech'
      const pattern = new RegExp(`^/${channel}/(\\d{4}-\\d{2}-\\d{2})$`)
      items = linkItems(
        html,
        sourceName,
        now,
        strategy.url,
        (href) => pattern.test(href),
        (href) => pattern.exec(href)?.[1],
        options,
      )
      break
    }
    case 'openai-models':
      items = linkItems(
        html,
        sourceName,
        now,
        strategy.url,
        (href) => /^\/api\/docs\/models\/[^/?#]+$/.test(href),
        () => undefined,
        options,
      )
      break
    case 'openai-news':
      items = linkItems(
        html,
        sourceName,
        now,
        strategy.url,
        (href) => /\/(index|news|research)\/[a-z0-9-]+\/?$/i.test(href),
        () => undefined,
        options,
      )
      break
    case 'claude-release-notes':
      items = parseClaudeReleaseNotes(html, sourceName, now, strategy.url, options)
      break
    case 'huggingface-blog':
      items = linkItems(
        html,
        sourceName,
        now,
        strategy.url,
        (href) => /^\/blog\/[^/?#]+(?:\/[^/?#]+)?$/.test(href) && href !== '/blog/community',
        () => undefined,
        options,
      )
      break
    case 'javascript-weekly':
      items = linkItems(
        html,
        sourceName,
        now,
        strategy.url,
        (href) => /^\/issues\/\d+$/.test(href),
        () => undefined,
        options,
      )
      break
  }
  return items.slice(0, strategy.limit)
}
