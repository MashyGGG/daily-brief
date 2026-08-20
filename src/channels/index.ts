import type { Recipient } from '../config/schema'
import { createWecomChannel } from './wecom'
import { createEmailChannel } from './email'
import { createServerChanChannel } from './serverchan'
import { createPushPlusChannel } from './pushplus'
import { createWxPusherChannel } from './wxpusher'
import { createTelegramChannel } from './telegram'
import { createStdoutChannel } from './stdout'
import type { Channel, ChannelContext, SendInput } from './types'

/** §3.4 — the registry. One line per channel. */
export const CHANNELS: Record<Recipient['channel'], (ctx: ChannelContext) => Channel> = {
  wecom: createWecomChannel,
  email: createEmailChannel,
  serverchan: createServerChanChannel,
  pushplus: createPushPlusChannel,
  wxpusher: createWxPusherChannel,
  telegram: createTelegramChannel,
  stdout: createStdoutChannel,
}

export function createChannel(name: Recipient['channel'], ctx: ChannelContext): Channel {
  const factory = CHANNELS[name]
  if (!factory) throw new Error(`unknown channel "${name}"`)
  return factory(ctx)
}

export type DeliveryStatus = 'sent' | 'skipped' | 'failed'

export interface DeliveryResult {
  recipient: string
  channel: string
  status: DeliveryStatus
  /** Why it was skipped, or how it failed (already redaction-safe by the time it is archived). */
  detail?: string
  durationMs: number
}

export interface DeliverOptions {
  ctx: ChannelContext
  /** recipient id → rendered payload. */
  payloads: Map<string, Omit<SendInput, 'recipient'>>
  /** Under --dry-run every recipient is routed to stdout instead of its real channel. */
  dryRun?: boolean
  /** Turns a thrown value into a message safe to print and to archive. */
  describeError?: (err: unknown) => string
}

/**
 * §3.2 / A6 — recipients are delivered concurrently, each in its own try/catch:
 * one dead channel never stops the others, and a missing secret is a *skip*, not a failure.
 */
export async function deliver(
  recipients: Recipient[],
  options: DeliverOptions,
): Promise<DeliveryResult[]> {
  const describe =
    options.describeError ?? ((err: unknown) => (err instanceof Error ? err.message : String(err)))

  return Promise.all(
    recipients.map(async (recipient): Promise<DeliveryResult> => {
      const at = Date.now()
      const base = { recipient: recipient.id, channel: recipient.channel }

      if (!recipient.enabled) {
        return { ...base, status: 'skipped', detail: 'disabled in config', durationMs: 0 }
      }
      const payload = options.payloads.get(recipient.id)
      if (!payload) {
        return { ...base, status: 'skipped', detail: 'nothing to send', durationMs: 0 }
      }

      try {
        const channel = options.dryRun
          ? createStdoutChannel(options.ctx)
          : createChannel(recipient.channel, options.ctx)

        // §3.1 rule 1: a secretRef pointing at an unset env var skips this recipient only.
        const missing = channel.missingEnv(recipient)
        if (missing.length > 0) {
          return {
            ...base,
            status: 'skipped',
            detail: `missing env: ${missing.join(', ')}`,
            durationMs: Date.now() - at,
          }
        }

        await channel.send({ ...payload, recipient })
        return { ...base, status: 'sent', durationMs: Date.now() - at }
      } catch (err) {
        return {
          ...base,
          status: 'failed',
          detail: describe(err),
          durationMs: Date.now() - at,
        }
      }
    }),
  )
}

export type { Channel, ChannelContext, SendInput, HttpFetch, Mailer } from './types'
export { ChannelError } from './types'
