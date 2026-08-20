import { describe, expect, it, vi } from 'vitest'
import { createWecomChannel } from '../src/channels/wecom'
import { createEmailChannel } from '../src/channels/email'
import { escapeMarkdownV2 } from '../src/channels/telegram'
import { deliver, type ChannelContext, type HttpFetch } from '../src/channels'
import type { Recipient } from '../src/config/schema'

const recipient = (over: Partial<Recipient> = {}): Recipient => ({
  id: 'r',
  channel: 'wecom',
  secretRef: 'WECOM_WEBHOOK_ME',
  sections: ['*'],
  format: 'markdown',
  enabled: true,
  ...over,
})

function ctx(over: Partial<ChannelContext> = {}): ChannelContext {
  return {
    env: { WECOM_WEBHOOK_ME: 'https://qyapi.weixin.qq.com/x?key=abc' },
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      text: async () => '{"errcode":0}',
    })) as HttpFetch,
    sleep: async () => {},
    ...over,
  }
}

const payload = (blocks: string[]) => ({
  title: '每日早报 · 2026-08-20',
  body: blocks.join('\n\n'),
  blocks,
  text: blocks.join('\n\n'),
})

describe('wecom channel', () => {
  it('sends a short brief as one request', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: { body?: string }) => ({
      ok: true,
      status: 200,
      text: async () => '{"errcode":0}',
    }))
    await createWecomChannel(ctx({ fetchImpl })).send({
      ...payload(['# 早报', '1. one']),
      recipient: recipient(),
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body!)
    expect(body.msgtype).toBe('markdown')
    expect(body.markdown.content).toContain('# 早报')
  })

  it('A8 — splits an oversized brief and paces the chunks', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: { body?: string }) => ({
      ok: true,
      status: 200,
      text: async () => '{"errcode":0}',
    }))
    const sleep = vi.fn(async () => {})
    const blocks = Array.from({ length: 60 }, (_, i) => `${i}. ${'中'.repeat(80)}`)
    await createWecomChannel(ctx({ fetchImpl, sleep })).send({
      ...payload(blocks),
      recipient: recipient(),
    })

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
    expect(sleep).toHaveBeenCalledTimes(fetchImpl.mock.calls.length - 1)
    for (const call of fetchImpl.mock.calls) {
      const content = JSON.parse(call[1]!.body!).markdown.content as string
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(4096)
    }
  })

  it('surfaces a provider-level rejection that arrives with HTTP 200', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"errcode":93000,"errmsg":"invalid webhook url"}',
    })
    await expect(
      createWecomChannel(ctx({ fetchImpl })).send({ ...payload(['x']), recipient: recipient() }),
    ).rejects.toThrow(/93000/)
  })

  it('reports the missing env var rather than sending', () => {
    expect(createWecomChannel(ctx({ env: {} })).missingEnv(recipient())).toEqual([
      'WECOM_WEBHOOK_ME',
    ])
  })
})

describe('email channel', () => {
  const mailRecipient = recipient({
    id: 'm',
    channel: 'email',
    driver: 'smtp',
    to: 'you@example.com',
    format: 'html',
    secretRef: undefined,
  })
  const smtpEnv = {
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PORT: '465',
    SMTP_USER: 'me@gmail.com',
    SMTP_PASS: 'app-pass',
    EMAIL_FROM: 'me@gmail.com',
  }

  it('sends to the address from the CONFIG, not from a workflow input (§0.2)', async () => {
    const sendMail = vi.fn(async (_message: Record<string, unknown>) => ({}))
    await createEmailChannel(ctx({ env: smtpEnv, createMailer: () => ({ sendMail }) })).send({
      ...payload(['<html>body</html>']),
      recipient: mailRecipient,
    })

    expect(sendMail.mock.calls[0]![0]).toMatchObject({
      to: 'you@example.com',
      from: 'me@gmail.com',
    })
  })

  it('uses port 465 as an implicit-TLS connection', async () => {
    const createMailer = vi.fn(
      (_options: { host: string; port: number; secure: boolean; user: string; pass: string }) => ({
        sendMail: async () => ({}),
      }),
    )
    await createEmailChannel(ctx({ env: smtpEnv, createMailer })).send({
      ...payload(['x']),
      recipient: mailRecipient,
    })
    expect(createMailer.mock.calls[0]![0]).toMatchObject({ port: 465, secure: true })
  })

  it('always includes a plain-text alternative next to the HTML', async () => {
    const sendMail = vi.fn(async (_message: Record<string, unknown>) => ({}))
    await createEmailChannel(ctx({ env: smtpEnv, createMailer: () => ({ sendMail }) })).send({
      title: 't',
      body: '<html>rich</html>',
      blocks: ['<html>rich</html>'],
      text: 'plain fallback',
      recipient: mailRecipient,
    })
    expect(sendMail.mock.calls[0]![0]).toMatchObject({
      html: '<html>rich</html>',
      text: 'plain fallback',
    })
  })

  it('lists every missing SMTP variable', () => {
    expect(createEmailChannel(ctx({ env: {} })).missingEnv(mailRecipient)).toEqual([
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USER',
      'SMTP_PASS',
      'EMAIL_FROM',
    ])
  })

  it('the resend driver needs only its API key', () => {
    const r = { ...mailRecipient, driver: 'resend' as const }
    expect(createEmailChannel(ctx({ env: {} })).missingEnv(r)).toEqual(['RESEND_API_KEY'])
    expect(createEmailChannel(ctx({ env: { RESEND_API_KEY: 're_x' } })).missingEnv(r)).toEqual([])
  })

  it('A6 — a bad password surfaces as a channel failure, not a crash', async () => {
    const channel = createEmailChannel(
      ctx({
        env: smtpEnv,
        createMailer: () => ({
          sendMail: async () => {
            throw new Error('535 5.7.8 Username and Password not accepted')
          },
        }),
      }),
    )
    await expect(channel.send({ ...payload(['x']), recipient: mailRecipient })).rejects.toThrow(
      /535/,
    )
  })
})

describe('telegram MarkdownV2 escaping', () => {
  it('escapes every reserved character', () => {
    expect(escapeMarkdownV2('a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s\\t')).toBe(
      'a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s\\\\t',
    )
  })

  it('leaves ordinary text alone', () => {
    expect(escapeMarkdownV2('plain 中文 text')).toBe('plain 中文 text')
  })
})

describe('deliver', () => {
  const payloads = new Map([
    ['a', payload(['x'])],
    ['b', payload(['x'])],
  ])

  it('A6 — one failure does not stop the others', async () => {
    const results = await deliver([recipient({ id: 'a' }), recipient({ id: 'b' })], {
      ctx: ctx({
        fetchImpl: (async (url: string) => {
          if (url.includes('bad')) throw new Error('boom')
          return { ok: true, status: 200, text: async () => '{"errcode":0}' }
        }) as HttpFetch,
        env: { WECOM_WEBHOOK_ME: 'https://good/x', WECOM_BAD: 'https://bad/x' },
      }),
      payloads,
    })
    expect(results.map((r) => r.status)).toEqual(['sent', 'sent'])
  })

  it('records a failure per recipient without throwing', async () => {
    const results = await deliver([recipient({ id: 'a' })], {
      ctx: ctx({
        fetchImpl: (async () => {
          throw new Error('boom')
        }) as unknown as HttpFetch,
      }),
      payloads,
    })
    expect(results[0]!.status).toBe('failed')
    expect(results[0]!.detail).toContain('boom')
  })

  it('skips a disabled recipient', async () => {
    const results = await deliver([recipient({ id: 'a', enabled: false })], {
      ctx: ctx(),
      payloads,
    })
    expect(results[0]).toMatchObject({ status: 'skipped', detail: 'disabled in config' })
  })

  it('routes everything to stdout under dry-run', async () => {
    const fetchImpl = vi.fn()
    const log = vi.fn()
    const results = await deliver([recipient({ id: 'a' })], {
      ctx: ctx({ fetchImpl: fetchImpl as unknown as HttpFetch, log }),
      payloads,
      dryRun: true,
    })
    expect(results[0]!.status).toBe('sent')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
  })
})
