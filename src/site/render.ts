import type { Item } from '../config/schema'
import { escapeHtml, safeHref } from '../render/html'
import { itemBody } from '../render/markdown'
import type { IssueSection, SiteIssue } from './collect'
import { groupByMonth } from './collect'

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue','PingFang SC','Microsoft YaHei',sans-serif"

/** The site's only stylesheet. Light/dark follows the reader's system setting. */
export const SITE_CSS = `:root{
  --bg:#ffffff; --fg:#1f2328; --muted:#6e7781; --line:#d8dee4;
  --link:#0969da; --card:#f6f8fa; --warn-bg:#fff8c5; --warn-line:#d4a72c; --warn-fg:#4d2d00;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --line:#30363d;
    --link:#4493f8; --card:#161b22; --warn-bg:#2d2412; --warn-line:#9e6a03; --warn-fg:#f2cc60;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:${FONT};line-height:1.6;
  -webkit-text-size-adjust:100%}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px 64px}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
header.top{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
  padding-bottom:14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
header.top h1{margin:0;font-size:20px;letter-spacing:-.2px}
header.top nav{font-size:13px;color:var(--muted)}
header.top nav a{margin-left:12px}
.sub{margin:8px 0 0;color:var(--muted);font-size:13px}
h2.section{margin:32px 0 2px;font-size:16px;padding-left:10px;border-left:3px solid var(--link)}
ol.items{list-style:none;margin:0;padding:0;counter-reset:i}
ol.items li{counter-increment:i;padding:12px 0;border-bottom:1px solid var(--line)}
ol.items li .t{font-size:15px;font-weight:600}
ol.items li .t::before{content:counter(i) ".";color:var(--muted);font-weight:400;margin-right:6px}
.meta{margin-top:4px;color:var(--muted);font-size:12px}
.excerpt{margin-top:6px;color:var(--muted);font-size:13px}
.takeaways{margin:6px 0 0;padding-left:18px;color:var(--muted);font-size:13px;line-height:1.7}
.warn{margin-top:28px;padding:12px 14px;border-radius:6px;font-size:13px;
  background:var(--warn-bg);border:1px solid var(--warn-line);color:var(--warn-fg)}
.warn ul{margin:6px 0 0;padding-left:18px}
.search{width:100%;margin:20px 0 4px;padding:9px 12px;font-size:14px;font-family:inherit;
  color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px}
.search:focus{outline:2px solid var(--link);outline-offset:-1px}
.tally{margin:0 0 20px;color:var(--muted);font-size:12px}
h2.month{margin:28px 0 6px;font-size:14px;color:var(--muted);font-weight:600;letter-spacing:.04em}
ul.issues{list-style:none;margin:0;padding:0}
ul.issues li{padding:10px 0;border-bottom:1px solid var(--line)}
ul.issues li[hidden]{display:none}
section[data-month][hidden]{display:none}
.row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.row .date{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.pill{font-size:11px;color:var(--muted);background:var(--card);border:1px solid var(--line);
  border-radius:999px;padding:1px 8px}
.peek{margin-top:3px;color:var(--muted);font-size:12px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pager{display:flex;justify-content:space-between;gap:12px;margin-top:36px;
  padding-top:16px;border-top:1px solid var(--line);font-size:13px}
footer.foot{margin-top:36px;padding-top:14px;border-top:1px solid var(--line);
  color:var(--muted);font-size:12px}
.empty{margin:48px 0;text-align:center;color:var(--muted)}
`

function page(opts: { title: string; up: string; body: string }): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(opts.title)}</title>`,
    `<link rel="stylesheet" href="${opts.up}assets/style.css">`,
    `<link rel="alternate" type="application/rss+xml" title="RSS" href="${opts.up}feed.xml">`,
    '</head><body><div class="wrap">',
    opts.body,
    '</div></body></html>',
    '',
  ].join('\n')
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function metaOf(item: Item): string {
  const parts = [item.source, hostOf(item.url)]
  if (typeof item.score === 'number' && item.score > 0) parts.push(String(item.score))
  if (item.author) parts.push(item.author)
  return parts.filter(Boolean).join(' · ')
}

function renderItem(item: Item): string {
  const body = itemBody(item)
  const excerpt = body ? `<div class="excerpt">${escapeHtml(body)}</div>` : ''
  const takeaways =
    item.takeaways && item.takeaways.length > 0
      ? `<ul class="takeaways">${item.takeaways.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
      : ''
  return [
    '<li>',
    `<div class="t"><a href="${safeHref(item.url)}" rel="noopener">${escapeHtml(item.title)}</a></div>`,
    `<div class="meta">${escapeHtml(metaOf(item))}</div>`,
    excerpt,
    takeaways,
    '</li>',
  ].join('')
}

function warningsBlock(warnings: string[]): string {
  if (warnings.length === 0) return ''
  return [
    '<div class="warn"><strong>抓取告警</strong><ul>',
    warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join(''),
    '</ul></div>',
  ].join('')
}

function topBar(siteTitle: string, up: string, current: 'index' | 'issue'): string {
  const home =
    current === 'index'
      ? `<h1>${escapeHtml(siteTitle)}</h1>`
      : `<h1><a href="${up}index.html">${escapeHtml(siteTitle)}</a></h1>`
  return [
    '<header class="top">',
    home,
    `<nav><a href="${up}index.html">全部</a><a href="${up}latest.html">最新</a><a href="${up}feed.xml">RSS</a></nav>`,
    '</header>',
  ].join('')
}

export interface IssuePageInput {
  siteTitle: string
  issue: SiteIssue
  sections: IssueSection[]
  /** The next issue back in time, if any. */
  older?: SiteIssue | undefined
  newer?: SiteIssue | undefined
}

export function renderIssuePage(input: IssuePageInput): string {
  const { record, up } = input.issue
  const heading = `${record.date}${record.slot ? ` · ${record.slot}` : ''}`

  const body = input.sections
    .map((section) =>
      [
        `<h2 class="section">${escapeHtml(section.title)}</h2>`,
        `<ol class="items">${section.items.map(renderItem).join('')}</ol>`,
      ].join(''),
    )
    .join('')

  const rel = (issue: SiteIssue | undefined, label: string): string =>
    issue ? `<a href="${up}${issue.path}">${label} ${issue.record.date}</a>` : '<span></span>'

  return page({
    title: `${input.siteTitle} · ${heading}`,
    up,
    body: [
      topBar(input.siteTitle, up, 'issue'),
      `<p class="sub">${escapeHtml(heading)} · ${escapeHtml(record.scheduleId)} · 回溯 ${record.lookbackHours}h · ${record.itemCount} 条</p>`,
      body || '<p class="empty">这一期没有达标内容。</p>',
      warningsBlock(record.warnings),
      `<div class="pager">${rel(input.older, '← 更早')}${rel(input.newer, '更新 →')}</div>`,
      `<footer class="foot">由 daily-brief 自动生成 · ${escapeHtml(record.generatedAt)} · config ${escapeHtml(record.configHash)}</footer>`,
    ].join(''),
  })
}

/** Everything a reader might type to find this issue again, pre-lowercased. */
export function searchKey(issue: SiteIssue): string {
  return [
    issue.record.date,
    issue.record.slot ?? '',
    ...issue.record.items.map((i) => `${i.title} ${i.source}`),
  ]
    .join(' ')
    .toLowerCase()
}

const SEARCH_JS = [
  '<script>',
  '(function(){',
  "  var q=document.getElementById('q');",
  '  if(!q)return;',
  "  var rows=[].slice.call(document.querySelectorAll('li[data-q]'));",
  "  var months=[].slice.call(document.querySelectorAll('section[data-month]'));",
  "  var tally=document.getElementById('tally');",
  '  function apply(){',
  '    var v=q.value.trim().toLowerCase();',
  '    var n=0;',
  '    rows.forEach(function(r){',
  "      var hit=!v||(r.getAttribute('data-q')||'').indexOf(v)>-1;",
  '      r.hidden=!hit;',
  '      if(hit)n++;',
  '    });',
  "    months.forEach(function(m){m.hidden=!m.querySelector('li[data-q]:not([hidden])');});",
  "    if(tally)tally.textContent=v?n+' / '+rows.length+' 期匹配':rows.length+' 期';",
  '  }',
  "  q.addEventListener('input',apply);",
  '  apply();',
  '})();',
  '</script>',
].join('\n')

export interface IndexPageInput {
  siteTitle: string
  issues: SiteIssue[]
  builtAt: string
}

export function renderIndexPage(input: IndexPageInput): string {
  if (input.issues.length === 0) {
    return page({
      title: input.siteTitle,
      up: '',
      body: [
        topBar(input.siteTitle, '', 'index'),
        '<p class="empty">暂无归档。第一期跑完后这里会自动出现。</p>',
        `<footer class="foot">构建于 ${escapeHtml(input.builtAt)}</footer>`,
      ].join(''),
    })
  }

  const months = groupByMonth(input.issues)
    .map((group) => {
      const rows = group.issues
        .map((issue) => {
          const peek = issue.record.items
            .slice(0, 3)
            .map((i) => i.title)
            .join('　·　')
          return [
            `<li data-q="${escapeHtml(searchKey(issue))}">`,
            '<div class="row">',
            `<a class="date" href="${issue.path}">${escapeHtml(issue.record.date)}</a>`,
            issue.record.slot ? `<span class="pill">${escapeHtml(issue.record.slot)}</span>` : '',
            `<span class="pill">${issue.record.itemCount} 条</span>`,
            '</div>',
            peek ? `<div class="peek">${escapeHtml(peek)}</div>` : '',
            '</li>',
          ].join('')
        })
        .join('')
      return [
        `<section data-month="${escapeHtml(group.month)}">`,
        `<h2 class="month">${escapeHtml(group.month)}</h2>`,
        `<ul class="issues">${rows}</ul>`,
        '</section>',
      ].join('')
    })
    .join('')

  return page({
    title: input.siteTitle,
    up: '',
    body: [
      topBar(input.siteTitle, '', 'index'),
      '<input id="q" class="search" type="search" placeholder="搜索标题、来源或日期…" autocomplete="off">',
      `<p class="tally" id="tally">${input.issues.length} 期</p>`,
      months,
      `<footer class="foot">共 ${input.issues.length} 期 · 构建于 ${escapeHtml(input.builtAt)} · <a href="feed.xml">RSS</a></footer>`,
      SEARCH_JS,
    ].join(''),
  })
}

/** A stable bookmark target: always bounces to the newest issue. */
export function renderLatestRedirect(issue: SiteIssue | undefined, siteTitle: string): string {
  const target = issue ? issue.path : 'index.html'
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    `<meta http-equiv="refresh" content="0; url=${escapeHtml(target)}">`,
    `<link rel="canonical" href="${escapeHtml(target)}">`,
    `<title>${escapeHtml(siteTitle)}</title>`,
    `</head><body><p><a href="${escapeHtml(target)}">${escapeHtml(siteTitle)}</a></p></body></html>`,
    '',
  ].join('\n')
}

export function renderNotFound(siteTitle: string): string {
  return page({
    title: `404 · ${siteTitle}`,
    up: '',
    body: [
      topBar(siteTitle, '', 'issue'),
      '<p class="empty">这个地址没有对应的内容。<a href="index.html">回到归档列表</a></p>',
    ].join(''),
  })
}

/** `https://x.github.io/daily-brief/` + `2026/08/a.html`, tolerant of a missing base. */
export function joinUrl(base: string, path: string): string {
  if (!base) return path
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

export interface FeedInput {
  siteTitle: string
  issues: SiteIssue[]
  baseUrl: string
  builtAt: string
  /** How many issues the feed carries; older ones stay on the site only. */
  keep?: number
}

/** RFC 822 date, which is what RSS 2.0 wants — `toUTCString` already emits it. */
function rfc822(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? new Date(0).toUTCString() : at.toUTCString()
}

export function renderFeed(input: FeedInput): string {
  const shown = input.issues.slice(0, input.keep ?? 30)
  const home = joinUrl(input.baseUrl, 'index.html')

  const items = shown
    .map((issue) => {
      const link = joinUrl(input.baseUrl, issue.path)
      const title = `${input.siteTitle} · ${issue.record.date}${
        issue.record.slot ? ` · ${issue.record.slot}` : ''
      }`
      const body = [
        '<ul>',
        issue.record.items
          .map(
            (i) =>
              `<li><a href="${safeHref(i.url)}">${escapeHtml(i.title)}</a> — ${escapeHtml(metaOf(i))}</li>`,
          )
          .join(''),
        '</ul>',
      ].join('')
      return [
        '    <item>',
        `      <title>${escapeHtml(title)}</title>`,
        `      <link>${escapeHtml(link)}</link>`,
        `      <guid isPermaLink="false">${escapeHtml(issue.path)}</guid>`,
        `      <pubDate>${rfc822(issue.record.generatedAt)}</pubDate>`,
        `      <description>${escapeHtml(body)}</description>`,
        '    </item>',
      ].join('\n')
    })
    .join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${escapeHtml(input.siteTitle)}</title>`,
    `    <link>${escapeHtml(home)}</link>`,
    `    <description>${escapeHtml(input.siteTitle)} 归档</description>`,
    '    <language>zh-cn</language>',
    `    <lastBuildDate>${rfc822(input.builtAt)}</lastBuildDate>`,
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n')
}
