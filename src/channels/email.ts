import { targetList, type Recipient } from '../config/schema'
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

/**
 * Who the mail is addressed to. EMAIL_TO (a secret, so the address never has to be
 * committed) REPLACES the config's `to` outright when set — it does not add to it.
 */
function resolveTo(ctx: ChannelContext, recipient: Recipient): string[] {
  return targetList(ctx.env.EMAIL_TO ?? recipient.to, 'EMAIL_TO')
}

export function createEmailChannel(ctx: ChannelContext): Channel {
  return {
    name: 'email',

    missingEnv(recipient: Recipient) {
      const missing =
        recipient.driver === 'resend'
          ? ctx.env.RESEND_API_KEY
            ? []
            : ['RESEND_API_KEY']
          : SMTP_ENV.filter((key) => !ctx.env[key])
      // No mailbox is a missing secret, not a broken config: skip this recipient and
      // say so in the run summary, exactly like an unset webhook on any other channel.
      if (resolveTo(ctx, recipient).length === 0) missing.push('EMAIL_TO')
      return [...missing]
    },

    async send({ recipient, title, body, text }: SendInput) {
      const to = resolveTo(ctx, recipient)
      if (to.length === 0)
        throw new ChannelError('email', `recipient "${recipient.id}" has no "to"`)
      const cc = targetList(ctx.env.EMAIL_CC ?? recipient.cc, 'EMAIL_CC').filter(
        (address) => !to.includes(address),
      )
      const html = recipient.format === 'html' ? body : undefined
      const plain = recipient.format === 'html' ? text : body

      if (recipient.driver === 'resend') {
        await sendViaResend(ctx, { to, cc, subject: title, html, text: plain })
        return
      }
      await sendViaSmtp(ctx, { to, cc, subject: title, html, text: plain })
    },
  }
}

async function sendViaSmtp(
  ctx: ChannelContext,
  message: { to: string[]; cc: string[]; subject: string; html?: string; text: string },
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
      // Nodemailer takes the header form; the arrays are the source of truth.
      to: message.to.join(', '),
      ...(message.cc.length ? { cc: message.cc.join(', ') } : {}),
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
  message: { to: string[]; cc: string[]; subject: string; html?: string; text: string },
): Promise<void> {
  const key = ctx.env.RESEND_API_KEY
  const from = ctx.env.EMAIL_FROM
  if (!key) throw new ChannelError('email', 'RESEND_API_KEY is not set')
  if (!from) throw new ChannelError('email', 'EMAIL_FROM is not set')

  await postJson(
    ctx,
    'email',
    'https://api.resend.com/emails',
    {
      from,
      to: message.to,
      ...(message.cc.length ? { cc: message.cc } : {}),
      subject: message.subject,
      html: message.html,
      text: message.text,
    },
    { authorization: `Bearer ${key}` },
  )
}
