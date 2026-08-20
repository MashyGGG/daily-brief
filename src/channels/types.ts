import type { Recipient } from '../config/schema'

export interface HttpResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpResponse>

/** Minimal surface of the nodemailer transport we depend on — injectable for tests. */
export interface Mailer {
  sendMail(message: {
    from: string
    to: string
    subject: string
    html?: string
    text?: string
  }): Promise<unknown>
}

export interface ChannelContext {
  env: NodeJS.ProcessEnv
  fetchImpl: HttpFetch
  /** Injectable so the WeCom rate-limit pause costs the tests nothing. */
  sleep: (ms: number) => Promise<void>
  /** Injectable so no test ever opens an SMTP connection. */
  createMailer?: (options: {
    host: string
    port: number
    secure: boolean
    user: string
    pass: string
  }) => Mailer
  log?: (message: string) => void
}

export interface SendInput {
  title: string
  /** The full rendered document. */
  body: string
  /** Atomic blocks, for channels that must chunk (§3.4). */
  blocks: string[]
  /** Plain-text alternative. */
  text: string
  recipient: Recipient
}

/** §3.4 — adding a channel is one file + one registry line + one boundary table. */
export interface Channel {
  readonly name: string
  /** Env vars this recipient needs but does not have; a non-empty result means "skip", not "fail". */
  missingEnv(recipient: Recipient): string[]
  send(input: SendInput): Promise<void>
}

export class ChannelError extends Error {
  constructor(
    readonly channel: string,
    message: string,
  ) {
    super(message)
    this.name = 'ChannelError'
  }
}

/** POST JSON and fail loudly on a non-2xx or an error payload. */
export async function postJson(
  ctx: ChannelContext,
  channel: string,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<string> {
  const res = await ctx.fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  if (!res.ok) throw new ChannelError(channel, `HTTP ${res.status}: ${text.slice(0, 300)}`)
  return text
}

/** Most Chinese push services answer 200 with a non-zero code in the body. */
export function assertOkCode(channel: string, text: string, okCodes: number[] = [0]): void {
  let parsed: { code?: number; errcode?: number; errmsg?: string; message?: string } | null = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return // Not JSON — the HTTP status already passed, so take it at face value.
  }
  if (!parsed) return
  const code = parsed.errcode ?? parsed.code
  if (typeof code === 'number' && !okCodes.includes(code)) {
    throw new ChannelError(
      channel,
      `provider rejected the message (code ${code}): ${parsed.errmsg ?? parsed.message ?? text.slice(0, 200)}`,
    )
  }
}
