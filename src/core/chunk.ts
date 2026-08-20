/**
 * §3.4 / A8 — WeCom caps a markdown body at 4096 **bytes**, not characters
 * (Chinese is 3 bytes per character in UTF-8). Telegram caps at 4096 characters.
 * Both need splitting that never cuts an entry in half and never cuts a character in half.
 */

export const WECOM_MAX_BYTES = 4096
export const TELEGRAM_MAX_CHARS = 4096

export type ChunkUnit = 'bytes' | 'chars'

export function measure(text: string, unit: ChunkUnit): number {
  return unit === 'bytes' ? Buffer.byteLength(text, 'utf8') : [...text].length
}

/**
 * Hard-split one oversized block at code-point boundaries.
 * Used only when a single entry cannot fit a chunk on its own.
 */
export function splitOversized(block: string, max: number, unit: ChunkUnit): string[] {
  const out: string[] = []
  let current = ''
  let size = 0
  for (const ch of block) {
    const chSize = measure(ch, unit)
    if (chSize > max) {
      // A single character wider than the whole budget: nothing sane to do but emit it.
      if (current !== '') {
        out.push(current)
        current = ''
        size = 0
      }
      out.push(ch)
      continue
    }
    if (size + chSize > max) {
      out.push(current)
      current = ch
      size = chSize
    } else {
      current += ch
      size += chSize
    }
  }
  if (current !== '') out.push(current)
  return out
}

/**
 * Pack atomic blocks into chunks of at most `max` units.
 *
 * A block is an entry (or a heading) and is never broken across chunks — unless it alone
 * exceeds the budget, in which case it is hard-split at character boundaries.
 */
export function chunkBlocks(
  blocks: string[],
  max: number = WECOM_MAX_BYTES,
  unit: ChunkUnit = 'bytes',
  separator = '\n\n',
): string[] {
  const sepSize = measure(separator, unit)
  const chunks: string[] = []
  let current = ''
  let size = 0

  const flush = () => {
    if (current !== '') {
      chunks.push(current)
      current = ''
      size = 0
    }
  }

  for (const raw of blocks) {
    const block = raw
    if (block === '') continue
    const blockSize = measure(block, unit)

    if (blockSize > max) {
      flush()
      for (const piece of splitOversized(block, max, unit)) chunks.push(piece)
      continue
    }

    const added = current === '' ? blockSize : sepSize + blockSize
    if (size + added > max) {
      flush()
      current = block
      size = blockSize
    } else {
      current = current === '' ? block : current + separator + block
      size += added
    }
  }

  flush()
  return chunks
}

/** Chunk a rendered document whose entries are already separated by blank lines. */
export function chunkDocument(
  text: string,
  max: number = WECOM_MAX_BYTES,
  unit: ChunkUnit = 'bytes',
): string[] {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim())
  return chunkBlocks(blocks, max, unit)
}
