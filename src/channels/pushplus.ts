import type { Recipient } from '../config/schema'
import { chunkBlocks } from '../core/chunk'
import {
  assertOkCode,
  postJson,
  ChannelError,
  type Channel,
  type ChannelContext,
  type SendInput,
} from './types'

/** §0.5 — PushPlus, 200 messages/day, 5/minute. Off by default. */
const PUSHPLUS_MAX_BYTES = 40 * 1024

export function createPushPlusChannel(ctx: ChannelContext): Channel {
  return {
    name: 'pushplus',

    missingEnv(recipient: Recipient) {
      const key = recipient.secretRef ?? ''
      return key && ctx.env[key] ? [] : [key || 'secretRef']
    },

    async send({ blocks, title, recipient }: SendInput) {
      const token = ctx.env[recipient.secretRef ?? '']
      if (!token) throw new ChannelError('pushplus', `missing secret ${recipient.secretRef}`)
      const [first = ''] = chunkBlocks(blocks, PUSHPLUS_MAX_BYTES, 'bytes')

      const text = await postJson(ctx, 'pushplus', 'https://www.pushplus.plus/send', {
        token,
        title,
        content: first,
        template: recipient.format === 'html' ? 'html' : 'markdown',
      })
      assertOkCode('pushplus', text, [200])
    },
  }
}
