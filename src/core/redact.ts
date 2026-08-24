/**
 * §3.5 / A16 — the archive is committed to a PUBLIC repo, so nothing that touches
 * a secret may reach `warnings`. Two layers:
 *   1. exact-value redaction of everything the process actually read from env;
 *   2. shape-based redaction for secrets that were never read but got echoed by an upstream.
 */

const MASK = '[REDACTED]'

/** Env vars whose values must never surface in committed output. */
// `EMAIL_TO` / `EMAIL_CC` / `ALERT_EMAIL_TO` are here because the archive is public
// and the recipient list is private — no address may surface in a warning.
// `_BASE_URL` covers `LLM_BASE_URL` (§6.2 item 4): `LLM_API_KEY` was already caught by
// `KEY$`, but a self-hosted endpoint can carry its own auth in the path or the query,
// and nothing else in this file would have matched it.
// `COOKIE` / `SESSION` cover PUBLISH.md §6's `JUEJIN_COOKIE`: a web session cookie IS the
// account credential, and it matched none of the names above.
const SECRET_ENV_PATTERN =
  /(TOKEN|SECRET|PASS|PASSWORD|KEY|WEBHOOK|APP_TOKEN|COOKIE|SESSION|_UID|_URL_SECRET|_BASE_URL|EMAIL_TO|EMAIL_CC)$/i

/** Env vars matching the pattern above that are nonetheless safe / structural. */
const SECRET_ENV_ALLOWLIST = new Set(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'EMAIL_FROM'])

const SHAPE_RULES: { re: RegExp; replace: string }[] = [
  // WeCom group-robot webhook: the whole point of the URL is the key.
  {
    re: /https?:\/\/qyapi\.weixin\.qq\.com\/[^\s"')]*/gi,
    replace: `https://qyapi.weixin.qq.com/${MASK}`,
  },
  // Telegram bot API URLs carry `bot<token>` in the path.
  {
    re: /https?:\/\/api\.telegram\.org\/bot[^/\s"')]+/gi,
    replace: `https://api.telegram.org/bot${MASK}`,
  },
  // Server酱 sendkey lives in the path.
  { re: /https?:\/\/sctapi\.ftqq\.com\/[^\s"')]*/gi, replace: `https://sctapi.ftqq.com/${MASK}` },
  // Any `key`/`token`/`sendkey`/`access_token` query parameter anywhere.
  {
    re: /([?&](?:key|token|sendkey|access_token|apikey|api_key)=)[^&\s"')]+/gi,
    replace: `$1${MASK}`,
  },
  // Common API-key shapes.
  { re: /\bre_[A-Za-z0-9_-]{12,}/g, replace: MASK },
  { re: /\bsk-[A-Za-z0-9_-]{12,}/g, replace: MASK },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: MASK },
  // Basic-auth credentials embedded in a URL.
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@"']+:[^/\s@"']+@/gi, replace: `$1${MASK}@` },
]

/** Collect the literal secret values present in `env`, longest first so substrings mask cleanly. */
export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 6) continue
    if (SECRET_ENV_ALLOWLIST.has(name)) continue
    if (!SECRET_ENV_PATTERN.test(name)) continue
    values.push(value)
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length)
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Mask every known secret value and secret-shaped substring in `text`. */
export function redact(text: string, secretValues: string[] = collectSecretValues()): string {
  let out = text
  for (const value of secretValues) {
    if (!value) continue
    out = out.split(value).join(MASK)
    // Webhook URLs are frequently logged URL-encoded.
    const encoded = encodeURIComponent(value)
    if (encoded !== value) out = out.split(encoded).join(MASK)
  }
  for (const { re, replace } of SHAPE_RULES) {
    out = out.replace(re, replace)
  }
  return out
}

/** Redact every string reachable inside an arbitrary value (used on the archived warnings). */
export function redactDeep<T>(value: T, secretValues: string[] = collectSecretValues()): T {
  if (typeof value === 'string') return redact(value, secretValues) as unknown as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secretValues)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, secretValues)
    }
    return out as unknown as T
  }
  return value
}

/** Turn a thrown value into a message that is safe to commit. */
export function safeErrorMessage(
  err: unknown,
  secretValues: string[] = collectSecretValues(),
): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return redact(raw, secretValues)
}

export { MASK as REDACTION_MASK, escapeRegExp }
