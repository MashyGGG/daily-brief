import type { Recipient } from '../config/schema'
import { restrictSections, type Brief } from '../core/brief'
import { renderMarkdown, renderMarkdownBlocks } from './markdown'
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

export function render(brief: Brief, format: Recipient['format']): Rendered {
  const text = renderText(brief)
  switch (format) {
    case 'html':
      return { format, body: renderHtml(brief), blocks: [renderHtml(brief)], text }
    case 'text':
      return { format, body: text, blocks: renderTextBlocks(brief), text }
    case 'markdown':
    default:
      return { format, body: renderMarkdown(brief), blocks: renderMarkdownBlocks(brief), text }
  }
}

/**
 * §3.2 — recipients sharing the same (sections, format) get the same rendered document.
 * Render once per signature, not once per person.
 */
export function renderForRecipients(brief: Brief, recipients: Recipient[]): Map<string, Rendered> {
  const cache = new Map<string, Rendered>()
  const byRecipient = new Map<string, Rendered>()

  for (const recipient of recipients) {
    const key = `${[...recipient.sections].sort().join(',')}|${recipient.format}`
    let rendered = cache.get(key)
    if (!rendered) {
      rendered = render(restrictSections(brief, recipient.sections), recipient.format)
      cache.set(key, rendered)
    }
    byRecipient.set(recipient.id, rendered)
  }
  return byRecipient
}

export { renderMarkdown, renderMarkdownBlocks } from './markdown'
export { renderHtml } from './html'
export { renderText } from './text'
