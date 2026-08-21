import { targetList, type Recipient } from '../config/schema'
import { chunkBlocks } from '../core/chunk'
import {
  assertOkCode,
  postJson,
  ChannelError,
  type Channel,
  type ChannelContext,
  type SendInput,
} from './types'

/**
 * §0.5 — WxPusher, 500 messages/day, messages expire after 7 days. Off by default.
 * `secretRef` holds the app token; `to` holds a UID list — comma-separated or an
 * array — where an entry may also be `topic:<id>`.
 */
const WXPUSHER_MAX_BYTES = 40 * 1024

export function createWxPusherChannel(ctx: ChannelContext): Channel {
  return {
    name: 'wxpusher',

    missingEnv(recipient: Recipient) {
      const key = recipient.secretRef ?? ''
      const missing = key && ctx.env[key] ? [] : [key || 'secretRef']
      if (!recipient.to && !ctx.env.WXPUSHER_UIDS) missing.push('WXPUSHER_UIDS')
      return missing
    },

    async send({ blocks, title, recipient }: SendInput) {
      const appToken = ctx.env[recipient.secretRef ?? '']
      if (!appToken) throw new ChannelError('wxpusher', `missing secret ${recipient.secretRef}`)

      const targets = targetList(recipient.to ?? ctx.env.WXPUSHER_UIDS)
      if (targets.length === 0) throw new ChannelError('wxpusher', 'no uids or topics configured')

      const [first = ''] = chunkBlocks(blocks, WXPUSHER_MAX_BYTES, 'bytes')
      const text = await postJson(
        ctx,
        'wxpusher',
        'https://wxpusher.zjiecode.com/api/send/message',
        {
          appToken,
          content: first,
          summary: title.slice(0, 100),
          contentType: recipient.format === 'html' ? 2 : 3,
          uids: targets.filter((t) => !t.startsWith('topic:')),
          topicIds: targets.filter((t) => t.startsWith('topic:')).map((t) => Number(t.slice(6))),
        },
      )
      assertOkCode('wxpusher', text, [1000])
    },
  }
}
