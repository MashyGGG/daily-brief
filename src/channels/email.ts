import type { Recipient } from '../config/schema'
import {
  ChannelError,
  postJson,
  type Channel,
  type ChannelContext,
  type Mailer,
  type SendInput,
} from './types'

/**
 * §0.2 / decision 1 — mail goes out over Gmail SMTP with an App Password:
 * free, no domain needed, arbitrary recipients. `resend` stays as a second driver
 * for the day a verified custom domain exists (the sandbox sender is refused at
 * config-validation time — see §3.1 rule 4).
 *
 * Sending happens **inside this code**, never in a workflow step: the recipient must
 * come from the config file, not from a `with:` block in the YAML.
 */

const SMTP_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'] as const

async function defaultMailer(options: {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
}): Promise<Mailer> {
  // Imported lazily so a run that sends no mail never loads nodemailer.
  const nodemailer = await import('nodemailer')
  return nodemailer.default.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: { user: options.user, pass: options.pass },
  }) as unknown as Mailer
}

export function createEmailChannel(ctx: ChannelContext): Channel {
  return {
    name: 'email',

    missingEnv(recipient: Recipient) {
      if (recipient.driver === 'resend') {
        return ctx.env.RESEND_API_KEY ? [] : ['RESEND_API_KEY']
      }
      return SMTP_ENV.filter((key) => !ctx.env[key])
    },

    async send({ recipient, title, body, text }: SendInput) {
      const to = recipient.to
      if (!to) throw new ChannelError('email', `recipient "${recipient.id}" has no "to"`)
      const html = recipient.format === 'html' ? body : undefined
      const plain = recipient.format === 'html' ? text : body

      if (recipient.driver === 'resend') {
        await sendViaResend(ctx, { to, subject: title, html, text: plain })
        return
      }
      await sendViaSmtp(ctx, { to, subject: title, html, text: plain })
    },
  }
}

async function sendViaSmtp(
  ctx: ChannelContext,
  message: { to: string; subject: string; html?: string; text: string },
): Promise<void> {
  const host = ctx.env.SMTP_HOST
  const user = ctx.env.SMTP_USER
  const pass = ctx.env.SMTP_PASS
  const from = ctx.env.EMAIL_FROM ?? user
  const port = Number(ctx.env.SMTP_PORT ?? '465')
  if (!host || !user || !pass || !from) {
    throw new ChannelError(
      'email',
      'SMTP_HOST / SMTP_USER / SMTP_PASS / EMAIL_FROM must all be set',
    )
  }
  if (!Number.isFinite(port))
    throw new ChannelError('email', `SMTP_PORT "${ctx.env.SMTP_PORT}" is not a number`)

  const mailer = ctx.createMailer
    ? ctx.createMailer({ host, port, secure: port === 465, user, pass })
    : await defaultMailer({ host, port, secure: port === 465, user, pass })

  try {
    await mailer.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    })
  } catch (err) {
    // The SMTP error text can echo the App Password back; keep it short and let
    // core/redact.ts scrub whatever survives before anything is committed.
    throw new ChannelError('email', `SMTP send failed: ${(err as Error).message}`)
  }
}

async function sendViaResend(
  ctx: ChannelContext,
  message: { to: string; subject: string; html?: string; text: string },
): Promise<void> {
  const key = ctx.env.RESEND_API_KEY
  const from = ctx.env.EMAIL_FROM
  if (!key) throw new ChannelError('email', 'RESEND_API_KEY is not set')
  if (!from) throw new ChannelError('email', 'EMAIL_FROM is not set')

  await postJson(
    ctx,
    'email',
    'https://api.resend.com/emails',
    { from, to: [message.to], subject: message.subject, html: message.html, text: message.text },
    { authorization: `Bearer ${key}` },
  )
}
