import type { Recipient, RenderConfig } from '../config/schema'
import { resolveDetail } from '../config/schema'
import { restrictSections, type Brief } from '../core/brief'
import { renderMarkdown, renderMarkdownBlocks, type Detail, type RenderOptions } from './markdown'
import { renderHtml } from './html'
import { renderText, renderTextBlocks } from './text'

export interface Rendered {
  format: Recipient['format']
  /** Full document — what a single-shot channel sends. */
  body: string
  /** Atomic blocks — what a length-capped channel packs into chunks. */
  blocks: string[]
  /** Plain-text alternative, always available (mail fallback). */
  text: string
}

export function render(
  brief: Brief,
  format: Recipient['format'],
  options: RenderOptions = {},
): Rendered {
  const text = renderText(brief, options)
  switch (format) {
    case 'html':
      return {
        format,
        body: renderHtml(brief, options),
        blocks: [renderHtml(brief, options)],
        text,
      }
    case 'text':
      return { format, body: text, blocks: renderTextBlocks(brief, options), text }
    case 'markdown':
    default:
      return {
        format,
        body: renderMarkdown(brief, options),
        blocks: renderMarkdownBlocks(brief, options),
        text,
      }
  }
}

/**
 * §3.2 / §5.2 — recipients sharing the same (sections, format, detail) get the same
 * rendered document. Render once per signature, not once per person. `detail` joined the
 * key at M2: without it the WeCom copy and the mail copy would collide and whichever ran
 * first would decide what the other one got.
 */
export function renderForRecipients(
  brief: Brief,
  recipients: Recipient[],
  renderConfig?: RenderConfig,
): Map<string, Rendered> {
  const cache = new Map<string, Rendered>()
  const byRecipient = new Map<string, Rendered>()

  for (const recipient of recipients) {
    const detail: Detail = resolveDetail(recipient)
    const key = `${[...recipient.sections].sort().join(',')}|${recipient.format}|${detail}`
    let rendered = cache.get(key)
    if (!rendered) {
      rendered = render(restrictSections(brief, recipient.sections), recipient.format, {
        detail,
        compactMaxChars: renderConfig?.compactMaxChars,
      })
      cache.set(key, rendered)
    }
    byRecipient.set(recipient.id, rendered)
  }
  return byRecipient
}

export { renderMarkdown, renderMarkdownBlocks } from './markdown'
export type { Detail, RenderOptions } from './markdown'
export { renderHtml } from './html'
export { renderText } from './text'
