import { decodeEntities } from '../core/normalize'
import type { ExtractConfig } from '../config/schema'

/**
 * §9 M2 — the milestone that makes the LLM worth paying for. M1 fed the model the feed's
 * own excerpt, which for `lobsters` is the literal word "Comments"; no amount of prompt
 * work turns that into "you don't need to click the link". This file goes and reads the
 * article.
 *
 * Two things make it different from `sources/*`: the URLs are **arbitrary** — they come
 * from whatever a feed decided to link to, not from a list somebody curated — and the
 * result is handed to a model whose output is committed to a public repo. So §6.2 item 3
 * applies in full: scheme allowlist, private-address refusal on every redirect hop,
 * content-type gate, hard size cap.
 *
 * `fetchImpl` is injected exactly as everywhere else, so no test here opens a socket.
 */

export interface ExtractResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type ExtractFetch = (
  url: string,
  init: {
    headers: Record<string, string>
    signal?: AbortSignal
    /** Redirects are followed by hand so every hop can be re-checked against §6.2. */
    redirect: 'manual'
  },
) => Promise<ExtractResponse>

export class ExtractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractError'
  }
}

/* ───────────────────────────── §6.2 item 3 — SSRF guard ───────────────────────────── */

/** Hostnames that name the runner itself or a name that only resolves inside a network. */
const PRIVATE_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.home.arpa']

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (octets.some((n) => Number.isNaN(n) || n > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true // this-network, private, loopback
  if (a === 169 && b === 254) return true // link-local, and with it the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a === 192 && b === 0) return true // IETF protocol assignments (incl. 192.0.0.0/24)
  if (a >= 224) return true // multicast and reserved, up to 255.255.255.255
  return false
}

/**
 * `::ffff:127.0.0.1` in dotted form, and in the `::ffff:7f00:1` hex form `new URL`
 * normalizes it to — the same loopback address wearing an IPv6 hat, twice.
 */
function mappedIpv4(inner: string): string | null {
  const tail = /^::ffff:(.+)$/.exec(inner)?.[1]
  if (!tail) return null
  if (tail.includes('.')) return tail
  const groups = tail.split(':')
  if (groups.length !== 2 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  const [high, low] = groups.map((g) => parseInt(g, 16)) as [number, number]
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

function isPrivateIpv6(host: string): boolean {
  // `new URL` keeps the brackets on an IPv6 literal.
  const inner = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (inner === '::' || inner === '::1') return true
  const mapped = mappedIpv4(inner)
  if (mapped) return isPrivateIpv4(mapped)
  if (/^f[cd][0-9a-f]{2}:/.test(inner)) return true // unique local
  if (/^fe[89ab][0-9a-f]:/.test(inner)) return true // link-local
  return false
}

/**
 * Whether a URL is safe to issue a GET against from inside CI. Refuses anything that is
 * not plain http(s), anything carrying credentials (they would end up in a log line), and
 * anything addressed at the runner or its network.
 *
 * What it deliberately does NOT promise: a public hostname that *resolves* to a private
 * address still gets fetched. Closing that needs DNS resolution plus a socket-level
 * check, which the injected-`fetch` seam cannot express — and the payoff here is one
 * article's text, not a credential.
 */
export function isFetchableUrl(input: string): boolean {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  const host = url.hostname.toLowerCase()
  if (host === '' || host === 'localhost') return false
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false
  if (host.startsWith('[')) return isPrivateIpv6(host) ? false : true
  if (/^[\d.]+$/.test(host)) return !isPrivateIpv4(host)
  return true
}

/** Only markup gets parsed: a PDF or a 40 MB video is not an article and not worth reading. */
const HTML_TYPES = ['text/html', 'application/xhtml+xml']

function isHtml(contentType: string | null): boolean {
  if (!contentType) return false
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  return HTML_TYPES.includes(type)
}

/* ────────────────────────────── HTML → readable text ────────────────────────────── */

/** Wrappers whose text is chrome, not content: it would drown the article in nav labels. */
const DROP_ELEMENTS =
  /<(script|style|noscript|template|svg|math|iframe|form|nav|aside|footer|header|figure|picture|video|audio|canvas|select|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

/** The same tags left unclosed by a malformed page would otherwise swallow the rest of it. */
const DROP_SELF_CLOSING = /<(?:script|style|noscript|template|svg|iframe)\b[^>]*\/>/gi

const COMMENTS = /<!--[\s\S]*?-->/g

/** Block-level boundaries become paragraph breaks; the model reads structure, not soup. */
const BLOCK_BOUNDARY =
  /<\/?(?:p|div|section|article|main|br|hr|h[1-6]|li|ul|ol|dl|dt|dd|tr|td|th|table|blockquote|pre|figcaption)\b[^>]*>/gi

/** `<article>` first, then `<main>` — the two tags that actually mean "this is the text". */
function mainRegion(html: string): string {
  for (const tag of ['article', 'main']) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i')
    const best = [...html.matchAll(new RegExp(re, 'gi'))]
      .map((m) => m[1] ?? '')
      // A page can carry several <article> blocks (a feed of teasers); the longest is the
      // one somebody wrote, the rest are cards.
      .sort((a, b) => b.length - a.length)[0]
    if (best && best.length > 200) return best
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)
  return body?.[1] ?? html
}

/**
 * Lines this short are almost always navigation, a byline fragment, or a share button's
 * label. Kept generous: real one-word paragraphs are rare, real nav labels are not.
 */
const MIN_LINE_CHARS = 2

/**
 * Anchors are marked before the tags come off so link density survives into the text.
 * Private-use code points: they cannot occur in real page text, and both are stripped
 * before anything is returned.
 */
const LINK_OPEN = '\ue000'
const LINK_CLOSE = '\ue001'
const LINK_MARKS = /[\ue000\ue001]/g

/**
 * A line this much of which is link text is a menu, a breadcrumb, or a row of related-post
 * cards — the chrome that survives on the many sites with no <article> or <main> to aim
 * at. Real prose containing a link is mostly not the link.
 */
const MAX_LINK_DENSITY = 0.6

/** Below this a line is too short for the ratio to mean anything, so it is judged whole. */
const LINK_DENSITY_MIN_CHARS = 0

function isNavigation(line: string): boolean {
  const open = line.indexOf(LINK_OPEN)
  if (open < 0) return false
  let inLink = false
  let linkChars = 0
  let textChars = 0
  for (const ch of line) {
    if (ch === LINK_OPEN) {
      inLink = true
      continue
    }
    if (ch === LINK_CLOSE) {
      inLink = false
      continue
    }
    if (/\s/.test(ch)) continue
    textChars++
    if (inLink) linkChars++
  }
  if (textChars <= LINK_DENSITY_MIN_CHARS) return true
  return linkChars / textChars > MAX_LINK_DENSITY
}

export function htmlToText(html: string): string {
  const cleaned = html
    .replace(COMMENTS, ' ')
    .replace(DROP_SELF_CLOSING, ' ')
    // Twice: one pass cannot remove a <figure> nested inside a <section> it also removes,
    // and a nav bar inside a header is exactly that shape.
    .replace(DROP_ELEMENTS, ' ')
    .replace(DROP_ELEMENTS, ' ')

  const text = decodeEntities(
    mainRegion(cleaned)
      .replace(/<a\b[^>]*>/gi, LINK_OPEN)
      .replace(/<\/a\s*>/gi, LINK_CLOSE)
      .replace(BLOCK_BOUNDARY, '\n')
      .replace(/<[^>]*>/g, ' '),
  )

  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/[\t\r\u00a0]/g, ' ')
        .replace(/ {2,}/g, ' ')
        .trim(),
    )
    .filter((line) => !isNavigation(line))
    .map((line) => line.replace(LINK_MARKS, '').replace(/ {2,}/g, ' ').trim())
    .filter((line) => [...line].length >= MIN_LINE_CHARS)
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/* ──────────────────────────────────── the fetch ──────────────────────────────────── */

export interface ExtractContext {
  fetchImpl: ExtractFetch
  config: ExtractConfig
  /** `budget.maxInputCharsPerItem` — the extracted text is cut to it before it is returned. */
  maxChars: number
}

export interface Extracted {
  text: string
  /** The URL the text actually came from, after redirects — recorded, never rendered. */
  finalUrl: string
}

const USER_AGENT = 'daily-brief (+https://github.com/MashyGGG/daily-brief)'

/**
 * Fetch one article and return its readable text, or throw an `ExtractError` the caller
 * turns into "keep the excerpt". Every refusal path throws rather than returning empty:
 * the reason is what the run-summary warning needs to say.
 */
export async function extractArticle(url: string, ctx: ExtractContext): Promise<Extracted> {
  const { config } = ctx
  if (!isFetchableUrl(url)) throw new ExtractError('refused url (not a public http(s) address)')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    let current = url
    for (let hop = 0; hop <= config.maxRedirects; hop++) {
      const res = await ctx.fetchImpl(current, {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: controller.signal,
        redirect: 'manual',
      })

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) throw new ExtractError(`HTTP ${res.status} without a location header`)
        // Resolved against the hop we are on, then re-checked: an open redirect on a
        // public site is the ordinary way to reach 169.254.169.254.
        let next: string
        try {
          next = new URL(location, current).href
        } catch {
          throw new ExtractError(`HTTP ${res.status} with an unparseable location`)
        }
        if (!isFetchableUrl(next))
          throw new ExtractError('refused redirect to a non-public address')
        current = next
        continue
      }

      if (!res.ok) throw new ExtractError(`HTTP ${res.status}`)
      const contentType = res.headers.get('content-type')
      if (!isHtml(contentType)) {
        throw new ExtractError(`not html (content-type: ${contentType ?? 'none'})`)
      }

      const html = await res.text()
      if (html.length > config.maxHtmlChars) {
        throw new ExtractError(`page too large: ${html.length} chars > ${config.maxHtmlChars}`)
      }
      const text = htmlToText(html)
      if ([...text].length < config.minChars) {
        // A paywall, a JS-only shell, or a page whose text lives somewhere this parser
        // does not look. Either way the excerpt is the better input, so say so.
        throw new ExtractError(`extracted only ${[...text].length} chars (< ${config.minChars})`)
      }
      return { text: [...text].slice(0, ctx.maxChars).join(''), finalUrl: current }
    }
    throw new ExtractError(`more than ${config.maxRedirects} redirects`)
  } finally {
    clearTimeout(timer)
  }
}
