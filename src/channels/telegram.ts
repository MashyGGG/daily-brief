import { targetList, type Recipient } from '../config/schema'
import { chunkBlocks, TELEGRAM_MAX_CHARS } from '../core/chunk'
import {
  assertOkCode,
  postJson,
  ChannelError,
  type Channel,
  type ChannelContext,
  type SendInput,
} from './types'

/**
 * §3.4 — Telegram caps at 4096 **characters** (not bytes) and MarkdownV2 requires
 * escaping a long list of punctuation, including inside link labels.
 */
const MDV2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g

export function escapeMarkdownV2(text: string): string {
  return text.replace(MDV2_SPECIAL, (ch) => `\\${ch}`)
}

const TELEGRAM_PAUSE_MS = 1000

export function createTelegramChannel(ctx: ChannelContext): Channel {
  return {
    name: 'telegram',

    missingEnv(recipient: Recipient) {
      const key = recipient.secretRef ?? ''
      const missing = key && ctx.env[key] ? [] : [key || 'secretRef']
      if (!recipient.to && !ctx.env.TELEGRAM_CHAT_ID) missing.push('TELEGRAM_CHAT_ID')
      return missing
    },

    async send({ blocks, recipient }: SendInput) {
      const token = ctx.env[recipient.secretRef ?? '']
      if (!token) throw new ChannelError('telegram', `missing secret ${recipient.secretRef}`)
      // One chat per recipient: extra targets in `to` would need one send each.
      const [chatId = ctx.env.TELEGRAM_CHAT_ID] = targetList(recipient.to)
      if (!chatId) throw new ChannelError('telegram', 'no chat id configured')

      // Blocks arrive as markdown; escape each one, then pack by character count.
      const escaped = blocks.map(escapeMarkdownV2)
      const chunks = chunkBlocks(escaped, TELEGRAM_MAX_CHARS, 'chars')

      for (let i = 0; i < chunks.length; i++) {
        const text = await postJson(
          ctx,
          'telegram',
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            chat_id: chatId,
            text: chunks[i],
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: true,
          },
        )
        assertOkCode('telegram', text, [0])
        if (i < chunks.length - 1) await ctx.sleep(TELEGRAM_PAUSE_MS)
      }
    },
  }
}
