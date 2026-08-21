import type { Item } from '../config/schema'
import { nonEmptySections, type Brief } from '../core/brief'
import { bodyFor, DIGEST_TITLE, type RenderOptions } from './markdown'

/**
 * §3.4 — mail clients strip <style> blocks and block remote assets, so everything is
 * inline and self-contained: no external CSS, no images, no webfonts.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Only http(s) links survive; anything else (javascript:, data:) is rendered inert. */
export function safeHref(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return escapeHtml(parsed.href)
  } catch {
    /* fall through */
  }
  return '#'
}

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue','PingFang SC','Microsoft YaHei',sans-serif"

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * §5.3 — the mail is the surface with no length ceiling, so it is the one that has to
 * deliver "read it and you're done": headline, the model's summary, its bullets, and the
 * source's own excerpt kept underneath as provenance.
 *
 * The excerpt is only shown when a summary replaced it — otherwise it IS the body above,
 * and printing it twice would be noise. `<details>` folds it away in clients that support
 * the tag and degrades to a labelled grey line in the ones that don't (Gmail among them),
 * which is why the label is inside the text rather than only in the disclosure triangle.
 */
function renderItem(item: Item, index: number, options: RenderOptions): string {
  const meta = [item.source, hostOf(item.url)]
  if (typeof item.score === 'number' && item.score > 0) meta.push(String(item.score))
  const body = bodyFor(item, options)
  const summary = body
    ? `<div style="margin:6px 0 0;color:#57606a;font-size:13px;line-height:1.6">${escapeHtml(body)}</div>`
    : ''
  const full = options.detail !== 'compact'
  const takeaways =
    full && item.takeaways && item.takeaways.length > 0
      ? `<ul style="margin:6px 0 0;padding-left:18px;color:#57606a;font-size:13px;line-height:1.7">${item.takeaways
          .map((t) => `<li>${escapeHtml(t)}</li>`)
          .join('')}</ul>`
      : ''
  const origin =
    full && item.summary && item.excerpt
      ? `<details style="margin:6px 0 0"><summary style="color:#8c959f;font-size:12px;cursor:pointer">原文摘要</summary>` +
        `<div style="margin:4px 0 0;color:#8c959f;font-size:12px;line-height:1.6">${escapeHtml(item.excerpt)}</div>` +
        `</details>`
      : ''
  return [
    '<tr><td style="padding:12px 0;border-bottom:1px solid #eaeef2">',
    `<div style="font-size:15px;line-height:1.5">`,
    `<span style="color:#8c959f">${index}.</span> `,
    `<a href="${safeHref(item.url)}" style="color:#0969da;text-decoration:none;font-weight:600">${escapeHtml(item.title)}</a>`,
    '</div>',
    `<div style="margin:4px 0 0;color:#8c959f;font-size:12px">${escapeHtml(meta.filter(Boolean).join(' · '))}</div>`,
    summary,
    takeaways,
    origin,
    '</td></tr>',
  ].join('')
}

/**
 * §5.3 — the 导读 opens the mail. Given its own card rather than a paragraph: it is the
 * one block on the page that is about the issue instead of about an item, and a reader
 * who only reads this should still have got something.
 */
function renderDigest(brief: Brief, options: RenderOptions): string {
  if (!brief.digest) return ''
  const title = escapeHtml(options.digestTitle ?? DIGEST_TITLE)
  return [
    '<div style="margin:20px 0 0;padding:14px 16px;background:#ffffff;border:1px solid #d0d7de;border-radius:8px">',
    `<div style="font-size:13px;font-weight:600;color:#0969da;letter-spacing:0.5px">${title}</div>`,
    `<div style="margin:6px 0 0;color:#1f2328;font-size:14px;line-height:1.75">${escapeHtml(brief.digest.text)}</div>`,
    '</div>',
  ].join('')
}

export function renderHtml(brief: Brief, options: RenderOptions = {}): string {
  const sections = nonEmptySections(brief)
  const body = sections
    .map((section) => {
      const items = section.items.map((item, i) => renderItem(item, i + 1, options)).join('')
      return [
        `<h2 style="margin:28px 0 4px;font-size:16px;color:#1f2328;border-left:3px solid #0969da;padding-left:10px">${escapeHtml(section.title)}</h2>`,
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${items}</table>`,
      ].join('')
    })
    .join('')

  const warnings =
    brief.warnings.length > 0
      ? [
          '<div style="margin:28px 0 0;padding:12px 14px;background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;color:#4d2d00;font-size:12px;line-height:1.6">',
          '<strong>抓取告警</strong><ul style="margin:6px 0 0;padding-left:18px">',
          brief.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join(''),
          '</ul></div>',
        ].join('')
      : ''

  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(brief.title)} · ${escapeHtml(brief.date)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f6f8fa">`,
    `<div style="max-width:680px;margin:0 auto;padding:24px 20px 40px;font-family:${FONT};color:#1f2328">`,
    `<h1 style="margin:0;font-size:22px;letter-spacing:-0.2px">${escapeHtml(brief.title)}</h1>`,
    `<div style="margin:6px 0 0;color:#8c959f;font-size:13px">${escapeHtml(brief.date)} · ${escapeHtml(brief.scheduleId)} · 回溯 ${brief.lookbackHours}h</div>`,
    options.digestPosition === 'bottom' ? '' : renderDigest(brief, options),
    body || '<p style="color:#57606a">今天没有达标内容。</p>',
    options.digestPosition === 'bottom' ? renderDigest(brief, options) : '',
    warnings,
    `<div style="margin:32px 0 0;padding-top:14px;border-top:1px solid #eaeef2;color:#8c959f;font-size:12px">由 daily-brief 自动生成 · ${escapeHtml(brief.generatedAt)}</div>`,
    '</div></body></html>',
  ].join('')
}
