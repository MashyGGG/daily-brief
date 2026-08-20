import type { Recipient } from '../config/schema'
import { chunkBlocks } from '../core/chunk'
import {
  assertOkCode,
  ChannelError,
  type Channel,
  type ChannelContext,
  type SendInput,
} from './types'

/** §0.5 — Server酱³, 5 messages/day on the free tier. Off by default. */
const SERVERCHAN_MAX_BYTES = 32 * 1024

export function createServerChanChannel(ctx: ChannelContext): Channel {
  return {
    name: 'serverchan',

    missingEnv(recipient: Recipient) {
      const key = recipient.secretRef ?? ''
      return key && ctx.env[key] ? [] : [key || 'secretRef']
    },

    async send({ blocks, title, recipient }: SendInput) {
      const key = ctx.env[recipient.secretRef ?? '']
      if (!key) throw new ChannelError('serverchan', `missing secret ${recipient.secretRef}`)
      // Only the first chunk is sent: the free tier is 5 messages/day, so splitting
      // one brief across several of them would burn the whole quota.
      const [first = ''] = chunkBlocks(blocks, SERVERCHAN_MAX_BYTES, 'bytes')

      // Server酱³ keys look like `sctp<uid>t<token>` and post to a per-uid host;
      // the legacy Turbo keys post to the shared sctapi host.
      const sctp = /^sctp(\d+)t/.exec(key)
      const url = sctp
        ? `https://${sctp[1]}.push.ft07.com/send/${key}.send`
        : `https://sctapi.ftqq.com/${key}.send`

      const res = await ctx.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title, desp: first }).toString(),
      })
      const text = await res.text()
      if (!res.ok) throw new ChannelError('serverchan', `HTTP ${res.status}: ${text.slice(0, 200)}`)
      assertOkCode('serverchan', text)
    },
  }
}
