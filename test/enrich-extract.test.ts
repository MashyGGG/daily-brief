import { describe, expect, it, vi } from 'vitest'
import { llmSchema } from '../src/config/schema'
import {
  extractArticle,
  htmlToText,
  isFetchableUrl,
  type ExtractFetch,
  type ExtractResponse,
} from '../src/enrich/extract'

const config = llmSchema.parse({}).extract
const ctx = (fetchImpl: ExtractFetch, maxChars = 6000) => ({ fetchImpl, config, maxChars })

function html(body: string, contentType = 'text/html; charset=utf-8'): ExtractResponse {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    text: () => Promise.resolve(body),
  }
}

function redirect(location: string | null, status = 302): ExtractResponse {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? location : null) },
    text: () => Promise.resolve(''),
  }
}

/** Long enough to clear `minChars` without any test having to care about the number. */
const ARTICLE = `<html><body><article><p>${'研究团队公布了新的推理框架。'.repeat(20)}</p></article></body></html>`

describe('§6.2 item 3 — the SSRF guard', () => {
  it('refuses everything that is not a public http(s) address', () => {
    for (const url of [
      'http://localhost/x',
      'http://127.0.0.1/x',
      'http://127.1.2.3/x',
      'http://10.0.0.5/x',
      'http://172.16.9.9/x',
      'http://172.31.255.255/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data/', // the cloud metadata endpoint
      'http://100.64.0.1/x',
      'http://0.0.0.0/x',
      'http://[::1]/x',
      'http://[::ffff:127.0.0.1]/x',
      'http://[fd00::1]/x',
      'http://[fe80::1]/x',
      'http://build.internal/x',
      'http://printer.local/x',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'javascript:alert(1)',
      'https://user:secret@example.com/x', // credentials would end up in a log line
      'not a url',
    ]) {
      expect(isFetchableUrl(url), url).toBe(false)
    }
  })

  it('allows the ordinary public article URLs the feeds actually link to', () => {
    for (const url of [
      'https://github.blog/2026-08-17-incident/',
      'http://example.com/a?b=c',
      'https://172.15.0.1/x', // just outside the 172.16/12 private block
      'https://192.169.0.1/x',
      'https://[2606:4700::1111]/x',
    ]) {
      expect(isFetchableUrl(url), url).toBe(true)
    }
  })

  it('re-checks every redirect hop — an open redirect is the usual way to reach the metadata IP', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(redirect('http://169.254.169.254/latest/meta-data/')),
    )
    await expect(extractArticle('https://example.com/a', ctx(fetchImpl))).rejects.toThrow(
      /refused redirect/,
    )
    // The dangerous hop was never issued: the guard runs on the Location, not on the answer.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('follows a public redirect and reads the page it lands on', async () => {
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(url.includes('/final') ? html(ARTICLE) : redirect('/final')),
    )
    const result = await extractArticle('https://example.com/a', ctx(fetchImpl))
    expect(result.finalUrl).toBe('https://example.com/final')
    expect(result.text).toContain('推理框架')
  })

  it('gives up rather than looping when a site redirects to itself', async () => {
    const fetchImpl = () => Promise.resolve(redirect('/next'))
    await expect(extractArticle('https://example.com/a', ctx(fetchImpl))).rejects.toThrow(
      /more than 3 redirects/,
    )
  })

  it('refuses a 3xx with no location header instead of treating it as a page', async () => {
    await expect(
      extractArticle(
        'https://example.com/a',
        ctx(() => Promise.resolve(redirect(null))),
      ),
    ).rejects.toThrow(/without a location/)
  })
})

describe('what is worth parsing', () => {
  it('only reads html — a PDF or an image is not an article', async () => {
    for (const type of ['application/pdf', 'image/png', 'application/json']) {
      await expect(
        extractArticle(
          'https://example.com/a',
          ctx(() => Promise.resolve(html(ARTICLE, type))),
        ),
      ).rejects.toThrow(/not html/)
    }
  })

  it('refuses a response with no content-type at all', async () => {
    const noType: ExtractResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(ARTICLE),
    }
    await expect(
      extractArticle(
        'https://example.com/a',
        ctx(() => Promise.resolve(noType)),
      ),
    ).rejects.toThrow(/not html/)
  })

  it('refuses a page past the size ceiling', async () => {
    const huge = html(`<article>${'x'.repeat(config.maxHtmlChars + 1)}</article>`)
    await expect(
      extractArticle(
        'https://example.com/a',
        ctx(() => Promise.resolve(huge)),
      ),
    ).rejects.toThrow(/page too large/)
  })

  it('refuses a 4xx', async () => {
    const notFound: ExtractResponse = {
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: () => Promise.resolve(''),
    }
    await expect(
      extractArticle(
        'https://example.com/a',
        ctx(() => Promise.resolve(notFound)),
      ),
    ).rejects.toThrow(/HTTP 404/)
  })

  it('treats a paywall stub as a failed extraction — the excerpt is the better input', async () => {
    const stub = html('<html><body><div id="app">Subscribe to read</div></body></html>')
    await expect(
      extractArticle(
        'https://example.com/a',
        ctx(() => Promise.resolve(stub)),
      ),
    ).rejects.toThrow(/extracted only \d+ chars/)
  })

  it('cuts the article to the per-item budget', async () => {
    const long = html(`<article><p>${'字'.repeat(9000)}</p></article>`)
    const result = await extractArticle(
      'https://example.com/a',
      ctx(() => Promise.resolve(long), 500),
    )
    expect([...result.text]).toHaveLength(500)
  })
})

describe('html → readable text', () => {
  it('drops the chrome and keeps the article', () => {
    const out = htmlToText(`
      <html><head><style>.a{color:red}</style><script>var x = "<p>not text</p>"</script></head>
      <body>
        <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
        <article><h1>GitHub 8·17 incident</h1><p>The write amplification lasted four hours.</p></article>
        <footer><p>Copyright 2026 Example Inc, all rights reserved</p></footer>
      </body></html>`)
    expect(out).toContain('GitHub 8·17 incident')
    expect(out).toContain('write amplification')
    expect(out).not.toContain('color:red')
    expect(out).not.toContain('not text')
    expect(out).not.toContain('About')
    expect(out).not.toContain('Copyright')
  })

  it('removes a nav nested inside a header, which one pass would leave behind', () => {
    const out = htmlToText(
      '<body><header><div><nav>Sections Menu Search</nav></div></header>' +
        '<article><p>Real body text goes here.</p></article></body>',
    )
    expect(out).not.toContain('Sections Menu Search')
    expect(out).toContain('Real body text')
  })

  it('picks the longest <article> — a teaser list is not the piece somebody wrote', () => {
    const short = '<article><p>Teaser card.</p></article>'
    const long = `<article><p>${'The real article body. '.repeat(30)}</p></article>`
    const out = htmlToText(`<body>${short}${long}${short}</body>`)
    expect(out).toContain('The real article body')
    expect(out).not.toContain('Teaser card')
  })

  it('falls back to <main>, then to <body>, when there is no <article>', () => {
    const main = `<body><nav>x</nav><main><p>${'Main region text. '.repeat(20)}</p></main></body>`
    expect(htmlToText(main)).toContain('Main region text')
    const bare = `<body><p>${'Just a body. '.repeat(20)}</p></body>`
    expect(htmlToText(bare)).toContain('Just a body')
  })

  it('keeps paragraph structure and decodes entities', () => {
    const out = htmlToText(
      '<article><p>First &amp; foremost.</p><p>Second&nbsp;paragraph &#8212; with a dash.</p></article>',
    )
    expect(out).toBe('First & foremost.\nSecond paragraph — with a dash.')
  })

  it('drops the one-character nav leftovers a real page is full of', () => {
    const out = htmlToText('<article><p>·</p><p>×</p><p>The sentence that matters.</p></article>')
    expect(out).toBe('The sentence that matters.')
  })

  it('drops a row that is nothing but links — most sites have no <article> to aim at', () => {
    const out = htmlToText(
      '<body><div class="menu"><a href="/">Home</a> <a href="/posts">Posts</a> ' +
        '<a href="/about">About</a> <a href="/feed">Subscribe</a></div>' +
        '<div><p>The paragraph somebody actually wrote.</p></div></body>',
    )
    expect(out).toBe('The paragraph somebody actually wrote.')
  })

  it('keeps a paragraph that merely contains a link', () => {
    const out = htmlToText(
      '<body><div><p>The release notes are <a href="/notes">published here</a> and they ' +
        'describe the new borrow checker in some detail.</p></div></body>',
    )
    expect(out).toContain('published here')
    expect(out).toContain('borrow checker')
  })

  it('leaves no trace of the markers it uses to measure link density', () => {
    const out = htmlToText(
      '<body><p>Read the <a href="/x">docs</a> for the whole story here.</p></body>',
    )
    expect(out).toBe('Read the docs for the whole story here.')
    expect(out).not.toMatch(/[\ue000\ue001]/)
  })

  it('decodes the named entities a real article is full of', () => {
    const out = htmlToText(
      '<article><p>Sponsored &mdash; it&rsquo;s 20&deg;C, &ldquo;quoted&rdquo;&hellip;</p></article>',
    )
    expect(out).toBe('Sponsored \u2014 it\u2019s 20\u00b0C, \u201cquoted\u201d\u2026')
  })

  it('survives malformed markup rather than swallowing the page', () => {
    const out = htmlToText('<article><p>Before <script src=x/> after the unclosed tag.</p>')
    expect(out).toContain('Before')
    expect(out).toContain('after the unclosed tag')
  })
})
