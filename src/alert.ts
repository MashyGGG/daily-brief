/**
 * §0.4 / §3.6 — Actions tells you nothing when a scheduled job fails, and "no brief today"
 * is indistinguishable from "no news today". The workflow's `if: failure()` step runs this
 * to push a one-liner down the same channels the brief itself uses.
 */
import { collectSecretValues, redact } from './core/redact'

async function postWecom(webhook: string, content: string): Promise<void> {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
  })
  if (!res.ok) throw new Error(`wecom alert HTTP ${res.status}`)
}

async function postMail(content: string): Promise<void> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, ALERT_EMAIL_TO } = process.env
  const to = ALERT_EMAIL_TO ?? SMTP_USER
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !to) return
  const nodemailer = await import('nodemailer')
  const port = Number(SMTP_PORT ?? '465')
  const transport = nodemailer.default.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  })
  await transport.sendMail({
    from: EMAIL_FROM ?? SMTP_USER,
    to,
    subject: '[daily-brief] 今日早报失败',
    text: content,
  })
}

async function main(): Promise<void> {
  const env = process.env
  const repo = env.GITHUB_REPOSITORY ?? 'daily-brief'
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
      : '(local run)'
  const reason = redact(env.ALERT_REASON ?? 'job failed', collectSecretValues(env))

  const content = [
    `**⚠️ 今日早报失败**`,
    `仓库：${repo}`,
    `原因：${reason}`,
    `日志：[查看运行](${runUrl})`,
  ].join('\n')

  console.error(content)

  const results = await Promise.allSettled([
    env.WECOM_WEBHOOK_ME
      ? postWecom(env.WECOM_WEBHOOK_ME, content)
      : Promise.reject(new Error('WECOM_WEBHOOK_ME unset')),
    postMail(content.replace(/\*\*/g, '')),
  ])

  const delivered = results.some((r) => r.status === 'fulfilled')
  if (!delivered) {
    console.error('Could not deliver the failure alert on any channel.')
    process.exitCode = 1
  }
}

void main()
