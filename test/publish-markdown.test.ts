import { describe, expect, it } from 'vitest'
import {
  batchBlocks,
  markdownToBlocks,
  richText,
  MAX_CHILDREN_PER_REQUEST,
  MAX_RICH_TEXT_CHARS,
  type NotionBlock,
} from '../src/publish/markdown'

const textOf = (block: NotionBlock): string => {
  const body = block[block.type] as { rich_text?: Array<{ text: { content: string } }> }
  return (body.rich_text ?? []).map((r) => r.text.content).join('')
}

const linkOf = (block: NotionBlock): string | undefined => {
  const body = block[block.type] as {
    rich_text?: Array<{ text: { link?: { url: string } } }>
  }
  return body.rich_text?.[0]?.text.link?.url
}

/** PUBLISH.md §5.2 — the six structures the publish renderer actually emits, and only those. */
describe('publish/markdown — the six structures', () => {
  it('maps headings by level', () => {
    const blocks = markdownToBlocks('# one\n\n## two\n\n### three\n')
    expect(blocks.map((b) => b.type)).toEqual(['heading_1', 'heading_2', 'heading_3'])
    expect(textOf(blocks[1]!)).toBe('two')
  })

  it('turns a numbered item into a numbered_list_item with a real link', () => {
    const [block] = markdownToBlocks('1. [Some title](https://example.com/a)')
    expect(block!.type).toBe('numbered_list_item')
    expect(textOf(block!)).toBe('Some title')
    expect(linkOf(block!)).toBe('https://example.com/a')
  })

  it('turns a dash line into a bulleted_list_item', () => {
    const [block] = markdownToBlocks('- a takeaway')
    expect(block!.type).toBe('bulleted_list_item')
    expect(textOf(block!)).toBe('a takeaway')
  })

  it('turns a quote into one quote block, joining consecutive lines', () => {
    const blocks = markdownToBlocks('> **导读** line one\n> line two\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('quote')
    expect(textOf(blocks[0]!)).toBe('**导读** line one\nline two')
  })

  it('turns a rule into a divider', () => {
    expect(markdownToBlocks('---')[0]!.type).toBe('divider')
  })

  it('drops anything else into a paragraph rather than crashing', () => {
    const blocks = markdownToBlocks('```js\nconst x = 1\n```')
    expect(blocks.every((b) => b.type === 'paragraph')).toBe(true)
  })

  it('flattens an item entry: indented continuation lines become their own bullets', () => {
    const blocks = markdownToBlocks(
      [
        '1. [T](https://e.com/1)',
        '   hn-front · e.com · 100',
        '   summary text',
        '   - takeaway',
      ].join('\n'),
    )
    expect(blocks.map((b) => b.type)).toEqual([
      'numbered_list_item',
      'bulleted_list_item',
      'bulleted_list_item',
      'bulleted_list_item',
    ])
  })
})

describe('publish/markdown — the hard limits', () => {
  it('splits a long string into several rich texts instead of truncating it', () => {
    const long = 'x'.repeat(MAX_RICH_TEXT_CHARS * 2 + 5)
    const parts = richText(long)
    expect(parts).toHaveLength(3)
    expect(parts.map((p) => p.text.content).join('')).toBe(long)
    expect(parts.every((p) => p.text.content.length <= MAX_RICH_TEXT_CHARS)).toBe(true)
  })

  it('carries the link on every piece of a split link label', () => {
    const parts = richText('y'.repeat(MAX_RICH_TEXT_CHARS + 1), 'https://e.com')
    expect(parts).toHaveLength(2)
    expect(parts.every((p) => p.text.link?.url === 'https://e.com')).toBe(true)
  })

  it('batches at exactly the 99 / 100 / 101 boundary', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `- item ${i}`).join('\n')

    const at99 = markdownToBlocks(make(99))
    expect(batchBlocks(at99).map((b) => b.length)).toEqual([99])

    const at100 = markdownToBlocks(make(100))
    expect(batchBlocks(at100).map((b) => b.length)).toEqual([100])

    const at101 = markdownToBlocks(make(101))
    expect(batchBlocks(at101).map((b) => b.length)).toEqual([100, 1])
  })

  it('never puts more than the cap in one request', () => {
    const blocks = markdownToBlocks(Array.from({ length: 350 }, (_, i) => `- item ${i}`).join('\n'))
    const batches = batchBlocks(blocks)
    expect(batches.every((b) => b.length <= MAX_CHILDREN_PER_REQUEST)).toBe(true)
    expect(batches.flat()).toHaveLength(350)
  })

  it('returns no batches at all for empty content', () => {
    expect(batchBlocks([])).toEqual([])
  })
})
