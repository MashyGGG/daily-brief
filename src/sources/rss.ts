import { XMLParser } from 'fast-xml-parser'
import type { RawItem, Source } from '../config/schema'
import { normalize, type NormalizeOptions } from '../core/normalize'
import { httpGetText, normalizeOptions, type FetchContext } from './types'

type RssSource = Extract<Source, { type: 'rss' }>

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  /**
   * fast-xml-parser counts EVERY entity — including predefined ones like `&amp;` — against
   * one document-wide billion-laughs budget, and the boolean form of `processEntities`
   * caps that budget at 1000. Real feeds blow straight through it: kubernetes.io ships
   * ~44k `&amp;`/`&#39;`, and a GitHub `releases.atom` ~32k. Those are 1:1 replacements
   * that SHRINK the string, so they cannot amplify anything.
   *
   * Amplification only comes from DOCTYPE-declared entities, which no feed we track even
   * has. So raise the count budget past what real feeds need, and keep the knobs that
   * actually bound a malicious DTD (`maxExpansionDepth`, `maxEntitySize`,
   * `maxExpandedLength`) at the strict boolean-mode defaults — passing an object would
   * otherwise silently relax `maxExpansionDepth` from 10 to 10000.
   */
  processEntities: {
    enabled: true,
    maxTotalExpansions: 500_000,
    maxExpansionDepth: 10,
    maxEntitySize: 10_000,
    maxExpandedLength: 100_000,
  },
})

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>
    if (typeof node['#text'] === 'string') return node['#text']
  }
  return undefined
}

/** Atom `<link rel="alternate" href="…">`, or the first href we can find. */
function atomLink(entry: Record<string, unknown>): string | undefined {
  const links = asArray(entry.link as unknown)
  for (const link of links) {
    if (typeof link === 'string') return link
    if (link && typeof link === 'object') {
      const node = link as Record<string, unknown>
      const rel = node['@_rel']
      const href = node['@_href']
      if (typeof href === 'string' && (rel === undefined || rel === 'alternate')) return href
    }
  }
  for (const link of links) {
    if (link && typeof link === 'object') {
      const href = (link as Record<string, unknown>)['@_href']
      if (typeof href === 'string') return href
    }
  }
  return undefined
}

/** Parse an RSS 2.0 or Atom document into raw items. Exported for the unit tests. */
export function parseFeed(
  xml: string,
  sourceName: string,
  now: Date,
  options: NormalizeOptions = {},
): RawItem[] {
  const doc = parser.parse(xml) as Record<string, unknown>

  const rssChannel = (doc.rss as Record<string, unknown> | undefined)?.channel as
    Record<string, unknown> | undefined
  const rdfItems = doc['rdf:RDF'] as Record<string, unknown> | undefined
  const atomFeed = doc.feed as Record<string, unknown> | undefined

  const entries: Record<string, unknown>[] = [
    ...asArray<Record<string, unknown>>(rssChannel?.item as never),
    ...asArray<Record<string, unknown>>(rdfItems?.item as never),
    ...asArray<Record<string, unknown>>(atomFeed?.entry as never),
  ].filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)

  const items: RawItem[] = []
  for (const entry of entries) {
    const title = text(entry.title) ?? ''
    const url = text(entry.link) ?? atomLink(entry) ?? text(entry.guid) ?? text(entry.id) ?? ''
    const published =
      text(entry.pubDate) ??
      text(entry.published) ??
      text(entry.updated) ??
      text(entry['dc:date']) ??
      undefined
    const excerpt =
      text(entry.description) ??
      text(entry.summary) ??
      text(entry.content) ??
      text(entry['content:encoded']) ??
      undefined
    const author =
      text(entry['dc:creator']) ??
      text(entry.author) ??
      text((entry.author as Record<string, unknown> | undefined)?.name) ??
      undefined

    const item = normalize(
      { title, url, source: sourceName, publishedAt: published, excerpt, author },
      now,
      options,
    )
    if (item) items.push(item)
  }
  return items
}

export async function fetchRss(source: RssSource, ctx: FetchContext): Promise<RawItem[]> {
  const xml = await httpGetText(source.params.url, ctx, {
    accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
  })
  return parseFeed(xml, source.name, ctx.now, normalizeOptions(source, ctx)).slice(
    0,
    source.params.limit,
  )
}
