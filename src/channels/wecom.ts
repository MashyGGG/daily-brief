import type { Recipient } from '../config/schema'
import { chunkBlocks, WECOM_MAX_BYTES } from '../core/chunk'
import { assertOkCode, postJson, type Channel, type ChannelContext, type SendInput } from './types'

/**
 * §0.5 / §3.4 — WeCom group robot: free, no third-party relay.
 * Hard limits: markdown body ≤ 4096 **bytes** (UTF-8, so ~1365 Chinese characters)
 * and 20 messages per minute. Chunks are paced ≥ 3s apart to stay clear of the latter.
 */
export const WECOM_CHUNK_PAUSE_MS = 3000

export function createWecomChannel(ctx: ChannelContext): Channel {
  return {
    name: 'wecom',

    missingEnv(recipient: Recipient) {
      const key = recipient.secretRef ?? ''
      return key && ctx.env[key] ? [] : [key || 'secretRef']
    },

    async send({ blocks, title, recipient }: SendInput) {
      const webhook = ctx.env[recipient.secretRef ?? '']
      if (!webhook) throw new Error(`missing secret ${recipient.secretRef}`)

      const chunks = chunkBlocks(blocks, WECOM_MAX_BYTES, 'bytes')
      for (let i = 0; i < chunks.length; i++) {
        const suffix = chunks.length > 1 ? `\n\n> ${title} · ${i + 1}/${chunks.length}` : ''
        const content = fitFooter(chunks[i]!, suffix)
        const text = await postJson(ctx, 'wecom', webhook, {
          msgtype: 'markdown',
          markdown: { content },
        })
        assertOkCode('wecom', text)
        if (i < chunks.length - 1) await ctx.sleep(WECOM_CHUNK_PAUSE_MS)
      }
    },
  }
}

/** Append the "n/m" footer only when it still fits inside the byte budget. */
function fitFooter(chunk: string, footer: string): string {
  if (footer === '') return chunk
  const combined = chunk + footer
  return Buffer.byteLength(combined, 'utf8') <= WECOM_MAX_BYTES ? combined : chunk
}
