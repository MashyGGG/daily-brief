import { describe, expect, it } from 'vitest'
import {
  chunkBlocks,
  chunkDocument,
  measure,
  splitOversized,
  WECOM_MAX_BYTES,
} from '../src/core/chunk'

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

describe('A8 — WeCom 4096-byte chunking', () => {
  it('leaves a short document as a single chunk', () => {
    const chunks = chunkBlocks(['# 早报', '1. one', '2. two'])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('# 早报')
  })

  it('never emits a chunk over the byte budget — pure ASCII', () => {
    const blocks = Array.from({ length: 200 }, (_, i) => `${i}. ${'a'.repeat(60)}`)
    for (const chunk of chunkBlocks(blocks)) {
      expect(bytes(chunk)).toBeLessThanOrEqual(WECOM_MAX_BYTES)
    }
  })

  it('never emits a chunk over the byte budget — pure Chinese (3 bytes per character)', () => {
    const blocks = Array.from({ length: 200 }, (_, i) => `${i}. ${'中'.repeat(60)}`)
    const chunks = chunkBlocks(blocks)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(WECOM_MAX_BYTES)
      // A character-counting implementation would have produced ~3× oversized chunks.
      expect([...chunk].length).toBeLessThan(WECOM_MAX_BYTES)
    }
  })

  it('never emits a chunk over the byte budget — mixed CJK and ASCII', () => {
    const blocks = Array.from(
      { length: 120 },
      (_, i) => `${i}. Rust 发布 1.90 版本 — ${'词'.repeat(30)}`,
    )
    for (const chunk of chunkBlocks(blocks)) {
      expect(bytes(chunk)).toBeLessThanOrEqual(WECOM_MAX_BYTES)
    }
  })

  it('never splits an entry across two chunks', () => {
    const blocks = Array.from({ length: 60 }, (_, i) => `${i}. ${'中'.repeat(80)}`)
    const chunks = chunkBlocks(blocks)
    for (const block of blocks) {
      expect(chunks.some((c) => c.includes(block))).toBe(true)
    }
  })

  it('keeps every block, in order', () => {
    const blocks = Array.from({ length: 50 }, (_, i) => `block-${i} ${'x'.repeat(200)}`)
    const rejoined = chunkBlocks(blocks).join('\n\n')
    expect(rejoined.split('\n\n').filter((b) => b.startsWith('block-'))).toHaveLength(50)
    expect(rejoined.indexOf('block-0')).toBeLessThan(rejoined.indexOf('block-49'))
  })

  it('does not corrupt multi-byte characters when hard-splitting one oversized entry', () => {
    const huge = '中'.repeat(3000) // 9000 bytes — bigger than the whole budget
    const chunks = chunkBlocks([huge])
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(WECOM_MAX_BYTES)
      // A byte-level slice would have produced U+FFFD replacement characters.
      expect(chunk).not.toContain('�')
      expect([...chunk].every((ch) => ch === '中')).toBe(true)
    }
    expect(chunks.join('')).toBe(huge)
  })

  it('does not split surrogate pairs', () => {
    const emoji = '🚀'.repeat(2000) // 4 bytes each
    for (const chunk of chunkBlocks([emoji])) {
      expect(chunk).not.toContain('�')
      expect([...chunk].every((ch) => ch === '🚀')).toBe(true)
    }
  })

  it('a block of exactly 4096 bytes fits in one chunk', () => {
    const exact = 'a'.repeat(WECOM_MAX_BYTES)
    expect(bytes(exact)).toBe(WECOM_MAX_BYTES)
    expect(chunkBlocks([exact])).toHaveLength(1)
  })

  it('a block of 4097 bytes is split into two', () => {
    const over = 'a'.repeat(WECOM_MAX_BYTES + 1)
    const chunks = chunkBlocks([over])
    expect(chunks).toHaveLength(2)
    expect(bytes(chunks[0]!)).toBe(WECOM_MAX_BYTES)
    expect(bytes(chunks[1]!)).toBe(1)
  })

  it('accounts for the separator when packing', () => {
    const half = 'a'.repeat(WECOM_MAX_BYTES / 2)
    // Two halves plus a 2-byte separator exceeds the budget by 2.
    expect(chunkBlocks([half, half])).toHaveLength(2)
  })

  it('skips empty blocks', () => {
    expect(chunkBlocks(['a', '', 'b'])).toEqual(['a\n\nb'])
  })

  it('handles an empty input', () => {
    expect(chunkBlocks([])).toEqual([])
  })
})

describe('character-unit chunking (Telegram)', () => {
  it('counts characters, not bytes', () => {
    const cn = '中'.repeat(100)
    expect(measure(cn, 'chars')).toBe(100)
    expect(measure(cn, 'bytes')).toBe(300)
    expect(chunkBlocks([cn], 100, 'chars')).toHaveLength(1)
    // 100 bytes holds 33 whole Chinese characters, so 100 of them need 4 chunks.
    expect(chunkBlocks([cn], 100, 'bytes')).toHaveLength(4)
  })
})

describe('splitOversized', () => {
  it('emits a single over-budget character rather than looping forever', () => {
    expect(splitOversized('中', 1, 'bytes')).toEqual(['中'])
  })
})

describe('chunkDocument', () => {
  it('treats blank-line-separated paragraphs as the atomic units', () => {
    const doc = ['# Title', '1. one', '2. two'].join('\n\n')
    expect(chunkDocument(doc, 20)).toEqual(['# Title\n\n1. one', '2. two'])
  })
})
