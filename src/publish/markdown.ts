/**
 * PUBLISH.md §5.2 — markdown → Notion blocks.
 *
 * The Notion API does not accept markdown, so this is the whole of Notion's real work.
 * It is deliberately NOT a general markdown parser: it supports the six structures the
 * publish renderer actually emits and drops everything else into a paragraph. Code
 * fences, tables and images are not supported because `adapt.ts` cannot produce them —
 * supporting them would be dead code, and a paragraph is ugly rather than broken.
 *
 * The hard limits are the reason this file exists at all:
 *
 *   children per request   ≤ 100     a 30-item issue is 150+ blocks → must batch
 *   rich text content      ≤ 2000    a long summary is split across several rich texts
 *   blocks per request     ≤ 1000    batching keeps us far below it
 *   request body           ≤ 500KB   likewise
 *   nesting depth          ≤ 2       sidestepped by staying flat
 */

/** Notion's cap on one `children` array. */
export const MAX_CHILDREN_PER_REQUEST = 100

/** Notion's cap on a single rich-text `content` string. */
export const MAX_RICH_TEXT_CHARS = 2000

export interface RichText {
  type: 'text'
  text: { content: string; link?: { url: string } }
}

export interface NotionBlock {
  object: 'block'
  type: string
  [key: string]: unknown
}

/**
 * One logical string as one or more rich-text objects.
 *
 * Splitting rather than truncating: the 2000-char ceiling is a transport limit, not an
 * editorial one, and silently losing the tail of a summary is the kind of bug nobody
 * notices for a month.
 */
export function richText(content: string, link?: string): RichText[] {
  if (content.length === 0) return []
  const out: RichText[] = []
  for (let at = 0; at < content.length; at += MAX_RICH_TEXT_CHARS) {
    const chunk = content.slice(at, at + MAX_RICH_TEXT_CHARS)
    out.push({ type: 'text', text: { content: chunk, ...(link ? { link: { url: link } } : {}) } })
  }
  return out
}

function block(type: string, rich: RichText[]): NotionBlock {
  return { object: 'block', type, [type]: { rich_text: rich } }
}

/** `[label](url)` at the start of a line — the shape every item line has. */
const LINK_RE = /^\[([^\]]+)\]\(([^)\s]+)\)\s*(.*)$/

/**
 * A line's rich text. Only the leading `[label](url)` is turned into a link: item lines
 * are `1. [title](url)` and nothing else in the generated markdown carries inline links,
 * so a full inline parser would be speculation.
 */
function lineRichText(text: string): RichText[] {
  const match = LINK_RE.exec(text)
  if (!match) return richText(text)
  const [, label, url, rest] = match
  return [...richText(label!, url), ...richText(rest ? ` ${rest}` : '')]
}

const HEADINGS: Record<number, string> = {
  1: 'heading_1',
  2: 'heading_2',
  3: 'heading_3',
}

/**
 * markdown → blocks, flat.
 *
 * Item entries in the generated markdown are multi-line (`1. [t](url)` then indented
 * meta / summary / takeaway lines). The indented continuation lines become their own
 * bulleted items rather than nested children: nesting depth is capped at 2 per request
 * and a flat list survives every batching boundary.
 */
export function markdownToBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = []
  const lines = markdown.split('\n')
  let paragraph: string[] = []

  const flush = (): void => {
    const text = paragraph.join(' ').trim()
    paragraph = []
    if (text) blocks.push(block('paragraph', lineRichText(text)))
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const trimmed = line.trim()

    if (trimmed === '') {
      flush()
      continue
    }
    if (/^-{3,}$/.test(trimmed)) {
      flush()
      blocks.push({ object: 'block', type: 'divider', divider: {} })
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flush()
      blocks.push(block(HEADINGS[heading[1]!.length]!, richText(heading[2]!.trim())))
      continue
    }
    const quote = /^>\s?(.*)$/.exec(trimmed)
    if (quote) {
      flush()
      const previous = blocks[blocks.length - 1]
      // Consecutive `>` lines are one quote in markdown; making them one block keeps the
      // digest reading as a paragraph instead of a stack of one-line quotes.
      if (previous?.type === 'quote') {
        const rich = (previous.quote as { rich_text: RichText[] }).rich_text
        rich.push(...richText(`\n${quote[1]!.trim()}`))
      } else {
        blocks.push(block('quote', richText(quote[1]!.trim())))
      }
      continue
    }
    const numbered = /^\d+\.\s+(.*)$/.exec(trimmed)
    if (numbered) {
      flush()
      blocks.push(block('numbered_list_item', lineRichText(numbered[1]!)))
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    if (bullet) {
      flush()
      blocks.push(block('bulleted_list_item', lineRichText(bullet[1]!)))
      continue
    }
    // An indented continuation line under an item: its own bullet, flat (see above).
    if (/^\s{2,}\S/.test(line) && blocks.length > 0) {
      flush()
      blocks.push(block('bulleted_list_item', lineRichText(trimmed)))
      continue
    }
    paragraph.push(trimmed)
  }
  flush()
  return blocks
}

/**
 * Split into request-sized batches. The first one rides along with `POST /v1/pages`;
 * every later one is its own `PATCH /v1/blocks/{id}/children`, sent serially because
 * Notion rate-limits at roughly 3 requests per second.
 */
export function batchBlocks(
  blocks: NotionBlock[],
  size = MAX_CHILDREN_PER_REQUEST,
): NotionBlock[][] {
  if (blocks.length === 0) return []
  const batches: NotionBlock[][] = []
  for (let at = 0; at < blocks.length; at += size) batches.push(blocks.slice(at, at + size))
  return batches
}
