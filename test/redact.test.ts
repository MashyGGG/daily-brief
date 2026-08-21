import { describe, expect, it } from 'vitest'
import { collectSecretValues, redact, redactDeep, safeErrorMessage } from '../src/core/redact'

const WEBHOOK =
  'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa'

describe('A16 — nothing secret reaches the public archive', () => {
  it('masks a WeCom webhook URL even when the value was never in env', () => {
    const out = redact(`POST ${WEBHOOK} failed`, [])
    expect(out).not.toContain('693a91f6')
    expect(out).toContain('REDACTED')
  })

  it('masks a Telegram bot token embedded in an API URL', () => {
    const out = redact('https://api.telegram.org/bot123456:AAH-abcdefg/sendMessage', [])
    expect(out).not.toContain('AAH-abcdefg')
  })

  it('masks a Server酱 sendkey', () => {
    expect(redact('https://sctapi.ftqq.com/SCT123456tABCDEF.send', [])).not.toContain('SCT123456t')
  })

  it('masks a bare key= query parameter on any host', () => {
    expect(redact('https://example.com/hook?key=supersecretvalue', [])).not.toContain(
      'supersecretvalue',
    )
  })

  it('masks Resend / OpenAI / GitHub key shapes', () => {
    const out = redact('re_abcdefghijklmnop sk-abcdefghijklmnop ghp_abcdefghijklmnopqrst', [])
    expect(out).not.toMatch(/re_abcdefghijklmnop/)
    expect(out).not.toMatch(/sk-abcdefghijklmnop/)
    expect(out).not.toMatch(/ghp_abcdefghijklmnopqrst/)
  })

  it('masks basic-auth credentials embedded in a URL', () => {
    expect(redact('smtp://me%40gmail.com:abcdefghijklmnop@smtp.gmail.com', [])).not.toContain(
      'abcdefghijklmnop',
    )
  })

  it('masks an exact secret value read from env, wherever it appears', () => {
    const out = redact('login failed for pass qwertyuiop1234', ['qwertyuiop1234'])
    expect(out).toBe('login failed for pass [REDACTED]')
  })

  it('masks a URL-encoded copy of the same secret', () => {
    const secret = 'a b+c/d'
    expect(redact(`x ${encodeURIComponent(secret)} y`, [secret])).not.toContain('a%20b')
  })

  it('leaves ordinary text untouched', () => {
    expect(redact('source "verge" failed: HTTP 500', [])).toBe('source "verge" failed: HTTP 500')
  })
})

describe('collectSecretValues', () => {
  it('picks up secret-shaped env names', () => {
    const values = collectSecretValues({
      WECOM_WEBHOOK_ME: 'https://qyapi.example/x',
      SMTP_PASS: 'abcdefghijklmnop',
      SERVERCHAN_KEY: 'sendkeyvalue',
      GITHUB_TOKEN: 'ghp_something',
    })
    expect(values).toContain('abcdefghijklmnop')
    expect(values).toContain('sendkeyvalue')
  })

  it('does not treat the structural SMTP settings as secrets', () => {
    const values = collectSecretValues({
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_USER: 'me@gmail.com',
      EMAIL_FROM: 'me@gmail.com',
      SMTP_PORT: '465',
    })
    expect(values).toEqual([])
  })

  it('ignores empty and very short values', () => {
    expect(collectSecretValues({ SMTP_PASS: '', OTHER_KEY: 'ab' })).toEqual([])
  })

  it('orders longest first so a substring cannot mask half of a longer secret', () => {
    const values = collectSecretValues({ A_KEY: 'abcdef', B_KEY: 'abcdefghijkl' })
    expect(values[0]).toBe('abcdefghijkl')
  })
})

describe('redactDeep', () => {
  it('reaches strings nested in objects and arrays', () => {
    const out = redactDeep(
      { warnings: [`failed: ${WEBHOOK}`], nested: { url: WEBHOOK }, count: 3, ok: true },
      [],
    )
    expect(JSON.stringify(out)).not.toContain('693a91f6')
    expect(out.count).toBe(3)
    expect(out.ok).toBe(true)
  })

  it('leaves null and undefined alone', () => {
    expect(redactDeep({ a: null, b: undefined }, [])).toEqual({ a: null, b: undefined })
  })
})

describe('safeErrorMessage', () => {
  it('renders an Error without leaking a secret in its message', () => {
    const err = new Error(`connect failed using ${WEBHOOK}`)
    const out = safeErrorMessage(err, [])
    expect(out).toMatch(/^Error: /)
    expect(out).not.toContain('693a91f6')
  })

  it('handles a thrown non-Error', () => {
    expect(safeErrorMessage('plain string', [])).toBe('plain string')
  })
})

describe('§6.2 item 4 — LLM_BASE_URL', () => {
  const ENDPOINT = 'https://llm.internal.example/tenants/acme-9f3c1b/openai/v1'

  it('is collected as a secret: a self-hosted endpoint can carry its own auth in the path', () => {
    expect(collectSecretValues({ LLM_BASE_URL: ENDPOINT })).toContain(ENDPOINT)
  })

  it('never reaches a committed warning', () => {
    const values = collectSecretValues({ LLM_BASE_URL: ENDPOINT })
    expect(redact(`POST ${ENDPOINT}/chat/completions failed`, values)).not.toContain('acme-9f3c1b')
  })

  it('LLM_API_KEY was already covered by the KEY$ rule', () => {
    expect(collectSecretValues({ LLM_API_KEY: 'sk-live-abcdef123456' })).toContain(
      'sk-live-abcdef123456',
    )
  })
})
