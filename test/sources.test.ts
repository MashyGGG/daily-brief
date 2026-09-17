import { describe, expect, it, vi } from 'vitest'
import { parseFeed } from '../src/sources/rss'
import { buildHnUrl, parseHnHits } from '../src/sources/hackernews'
import { buildGithubUrl, parseRepos, parseTrending } from '../src/sources/github'
import { fetchAll, sourceRunsToday, type FetchContext } from '../src/sources'
import { httpGetText, MAX_RESPONSE_CHARS } from '../src/sources/types'
import { parseHtmlProfile } from '../src/sources/html'
import { toExcerpt, stripHtml, normalize } from '../src/core/normalize'
import type { Source } from '../src/config/schema'
import { NOW } from './helpers'

const ctx = (text: string, ok = true): FetchContext => ({
  now: NOW,
  env: {},
  timeoutMs: 1000,
  fetchImpl: async () => ({ ok, status: ok ? 200 : 500, text: async () => text }),
})

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Feed</title>
  <item>
    <title>First &amp; foremost</title>
    <link>https://a.com/1</link>
    <pubDate>Wed, 19 Aug 2026 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;Some &lt;b&gt;html&lt;/b&gt; summary&lt;/p&gt;</description>
    <dc:creator>Ada</dc:creator>
  </item>
  <item>
    <title>Second</title>
    <link>https://a.com/2</link>
  </item>
</channel></rss>`

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom entry</title>
    <link rel="alternate" href="https://b.com/1"/>
    <link rel="edit" href="https://b.com/edit"/>
    <updated>2026-08-19T10:00:00Z</updated>
    <summary>Atom summary</summary>
  </entry>
</feed>`

describe('rss / atom parsing', () => {
  it('parses RSS 2.0 and decodes entities', () => {
    const items = parseFeed(RSS, 'verge', NOW)
    expect(items).toHaveLength(2)
    expect(items[0]!.title).toBe('First & foremost')
    expect(items[0]!.url).toBe('https://a.com/1')
    expect(items[0]!.author).toBe('Ada')
    expect(items[0]!.excerpt).toBe('Some html summary')
    expect(items[0]!.publishedAt).toBe('2026-08-19T10:00:00.000Z')
  })

  it('falls back to the fetch time when an item carries no date', () => {
    expect(parseFeed(RSS, 'verge', NOW)[1]!.publishedAt).toBe(NOW.toISOString())
  })

  it('parses Atom and picks the alternate link', () => {
    const items = parseFeed(ATOM, 'lobsters', NOW)
    expect(items[0]!.url).toBe('https://b.com/1')
    expect(items[0]!.excerpt).toBe('Atom summary')
  })

  it('returns nothing for an empty feed rather than throwing', () => {
    expect(parseFeed('<rss version="2.0"><channel/></rss>', 'x', NOW)).toEqual([])
  })

  it('skips entries with no title or no link', () => {
    const xml = `<rss version="2.0"><channel><item><title>No link</title></item></channel></rss>`
    expect(parseFeed(xml, 'x', NOW)).toEqual([])
  })

  // fast-xml-parser bills predefined entities to its billion-laughs budget, whose boolean
  // default is 1000. Real feeds carry tens of thousands of `&amp;` — kubernetes.io ~44k,
  // a GitHub releases.atom ~32k — so the default silently killed 9 of our 45 sources.
  it('parses a feed carrying far more predefined entities than the default budget', () => {
    const noisy = Array.from(
      { length: 3000 },
      (_, i) =>
        `<item><title>Q&amp;A &#39;${i}&#39; &quot;x&quot;</title>` +
        `<link>https://e.com/${i}?a=1&amp;b=2</link></item>`,
    ).join('')
    const items = parseFeed(`<rss version="2.0"><channel>${noisy}</channel></rss>`, 'x', NOW)

    expect(items).toHaveLength(3000)
    expect(items[0]!.title).toBe(`Q&A '0' "x"`)
    // Entities inside the URL matter most: an undecoded `&amp;` is a broken link.
    expect(items[0]!.url).toBe('https://e.com/0?a=1&b=2')
  })
})

describe('response size guard', () => {
  it('refuses a response larger than the cap instead of handing it to the parser', async () => {
    const huge = 'x'.repeat(MAX_RESPONSE_CHARS + 1)
    await expect(httpGetText('https://e.com/feed', ctx(huge))).rejects.toThrow(/response too large/)
  })

  it('accepts a response exactly at the cap', async () => {
    const atCap = 'x'.repeat(MAX_RESPONSE_CHARS)
    await expect(httpGetText('https://e.com/feed', ctx(atCap))).resolves.toHaveLength(
      MAX_RESPONSE_CHARS,
    )
  })

  it('retries with exponential backoff when a tech source opts in', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('reset'))
      .mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })
    const sleep = vi.fn(async () => {})
    await expect(
      httpGetText('https://e.com/feed', {
        ...ctx(''),
        fetchImpl,
        retries: 2,
        sleep,
      }),
    ).resolves.toBe('ok')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(250)
  })
})

describe('HTML source profiles', () => {
  it('parses TLDR archive links and their dates', () => {
    const items = parseHtmlProfile(
      '<a href="/ai/2026-08-20">Agents and models</a><a href="/other">skip</a>',
      {
        type: 'html',
        url: 'https://tldr.tech/ai/archives',
        profile: 'tldr-ai',
        limit: 10,
      },
      'tldr-ai',
      NOW,
    )
    expect(items).toHaveLength(1)
    expect(items[0]!.url).toBe('https://tldr.tech/ai/2026-08-20')
    expect(items[0]!.publishedAt).toBe('2026-08-20T00:00:00.000Z')
  })

  it('parses GitHub Trending cards', () => {
    const html = `<article><h2><a href="/owner/repo">owner / repo</a></h2>
      <p>A useful tool</p><span>321 stars today</span></article>`
    const items = parseTrending(html, 'github', NOW)
    expect(items[0]).toMatchObject({ title: 'owner/repo', score: 321 })
    expect(items[0]!.excerpt).toBe('A useful tool')
  })
})

describe('source cadence', () => {
  it('uses the configured timezone for weekly sources', () => {
    const source: Source = {
      name: 'weekly',
      type: 'rss',
      weight: 1,
      stripPatterns: [],
      runOnWeekdays: [5],
      params: { url: 'https://e.com/rss', limit: 10 },
    }
    // Thursday UTC, already Friday in Asia/Shanghai.
    expect(sourceRunsToday(source, new Date('2026-08-20T16:30:00Z'), 'Asia/Shanghai')).toBe(true)
    expect(sourceRunsToday(source, NOW, 'Asia/Shanghai')).toBe(false)
  })
})

describe('composite sources', () => {
  it('uses a fallback without creating a second logical source', async () => {
    const source: Source = {
      name: 'radar',
      type: 'composite',
      weight: 1,
      stripPatterns: [],
      params: {
        limit: 20,
        streams: [
          {
            primary: {
              type: 'html',
              url: 'https://tldr.tech/ai/archives',
              profile: 'tldr-ai',
              limit: 20,
            },
            fallbacks: [{ type: 'rss', url: 'https://e.com/rss', limit: 20 }],
          },
        ],
      },
    }
    const outcomes = await fetchAll([source], {
      ...ctx(''),
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        text: async () => (url.includes('tldr.tech') ? '<html>empty</html>' : RSS),
      }),
    })
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.source).toBe('radar')
    expect(outcomes[0]!.items).toHaveLength(2)
  })

  it('establishes an incremental baseline and emits only the newest item', async () => {
    const source: Source = {
      name: 'models',
      type: 'composite',
      weight: 1,
      stripPatterns: [],
      params: {
        limit: 20,
        streams: [
          {
            primary: {
              type: 'html',
              url: 'https://developers.openai.com/api/docs/models',
              profile: 'openai-models',
              incremental: true,
              limit: 20,
            },
            fallbacks: [],
          },
        ],
      },
    }
    const html =
      '<a href="/api/docs/models/new">New model</a><a href="/api/docs/models/old">Old model</a>'
    const [first] = await fetchAll([source], ctx(html))
    expect(first!.items.map((item) => item.title)).toEqual(['New model'])
    expect(first!.observedIds).toHaveLength(2)

    const [second] = await fetchAll([source], {
      ...ctx(html),
      seenIdsBySource: { models: first!.observedIds! },
    })
    expect(second!.items).toEqual([])
    expect(second!.error).toBeUndefined()
  })
})

describe('hackernews', () => {
  it('builds the front-page query', () => {
    const url = buildHnUrl({ mode: 'front_page', minPoints: 100, limit: 50 })
    expect(url).toContain('/search?')
    expect(url).toContain('tags=front_page')
  })

  it('builds a by-date query with the points filter', () => {
    const url = buildHnUrl({ mode: 'new', minPoints: 100, limit: 50 })
    expect(url).toContain('/search_by_date?')
    expect(url).toContain('numericFilters=points%3E100')
  })

  it('maps hits, carrying points through as the score', () => {
    const items = parseHnHits(
      [
        {
          objectID: '1',
          title: 'Story',
          url: 'https://a.com/x',
          points: 250,
          created_at: '2026-08-19T10:00:00Z',
          num_comments: 12,
          author: 'ada',
        },
      ],
      'hn-front',
      NOW,
    )
    expect(items[0]!.score).toBe(250)
    expect(items[0]!.excerpt).toContain('250 points')
  })

  it('links a text post to its discussion page', () => {
    const items = parseHnHits([{ objectID: '42', title: 'Ask HN: why?', url: null }], 'hn', NOW)
    expect(items[0]!.url).toBe('https://news.ycombinator.com/item?id=42')
  })
})

describe('github', () => {
  it('builds a created:> + language query sorted by stars', () => {
    const url = buildGithubUrl(
      { language: 'typescript', createdWithinDays: 7, minStars: 50, limit: 30 },
      NOW,
    )
    expect(decodeURIComponent(url)).toContain('created:>2026-08-13')
    expect(decodeURIComponent(url)).toContain('language:typescript')
    expect(decodeURIComponent(url)).toContain('stars:>=50')
    expect(url).toContain('sort=stars')
  })

  it('never touches the trending HTML page', () => {
    const url = buildGithubUrl({ createdWithinDays: 7, minStars: 0, limit: 30 }, NOW)
    expect(url.startsWith('https://api.github.com/search/repositories')).toBe(true)
  })

  it('maps repos, carrying stars through as the score', () => {
    const items = parseRepos(
      [
        {
          full_name: 'a/b',
          html_url: 'https://github.com/a/b',
          description: 'A thing',
          stargazers_count: 400,
          created_at: '2026-08-18T00:00:00Z',
          language: 'TypeScript',
          owner: { login: 'a' },
        },
      ],
      'gh',
      NOW,
    )
    expect(items[0]!.score).toBe(400)
    expect(items[0]!.title).toBe('a/b')
    expect(items[0]!.excerpt).toContain('★400')
  })

  it('sends the token when one is available', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) => ({
      ok: true,
      status: 200,
      text: async () => '{"items":[]}',
    }))
    const { fetchGithub } = await import('../src/sources/github')
    await fetchGithub(
      {
        name: 'gh',
        type: 'github',
        weight: 1,
        stripPatterns: [],
        params: { createdWithinDays: 7, minStars: 0, limit: 30 },
      },
      { now: NOW, env: { GITHUB_TOKEN: 'ghp_x' }, timeoutMs: 1000, fetchImpl },
    )
    expect(fetchImpl.mock.calls[0]![1]!.headers!.authorization).toBe('Bearer ghp_x')
  })
})

describe('normalize', () => {
  it('strips HTML out of an excerpt', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world')
  })

  it('truncates an excerpt to 300 characters', () => {
    const long = '中'.repeat(500)
    const excerpt = toExcerpt(long)!
    expect([...excerpt]).toHaveLength(300)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('leaves a short excerpt alone', () => {
    expect(toExcerpt('short')).toBe('short')
  })

  it('drops an entry with no title or no url', () => {
    expect(normalize({ title: '', url: 'https://a.com', source: 'x' }, NOW)).toBeNull()
    expect(normalize({ title: 'x', url: '', source: 'x' }, NOW)).toBeNull()
  })
})

describe('A5 — a failing source never takes down the brief', () => {
  const sources: Source[] = [
    {
      name: 'good',
      type: 'rss',
      weight: 1,
      stripPatterns: [],
      params: { url: 'https://a.com/rss', limit: 50 },
    },
    {
      name: 'bad',
      type: 'rss',
      weight: 1,
      stripPatterns: [],
      params: { url: 'https://b.com/rss', limit: 50 },
    },
  ]

  it('records a warning for the failure and keeps the good source', async () => {
    const outcomes = await fetchAll(sources, {
      now: NOW,
      env: {},
      timeoutMs: 1000,
      fetchImpl: async (url) => {
        if (url.includes('b.com')) throw new Error('ECONNRESET')
        return { ok: true, status: 200, text: async () => RSS }
      },
    })
    const good = outcomes.find((o) => o.source === 'good')!
    const bad = outcomes.find((o) => o.source === 'bad')!
    expect(good.items).toHaveLength(2)
    expect(good.error).toBeUndefined()
    expect(bad.items).toEqual([])
    expect(bad.error).toContain('ECONNRESET')
  })

  it('treats a 500 as a failure of that source only', async () => {
    const outcomes = await fetchAll([sources[1]!], ctx('', false))
    expect(outcomes[0]!.error).toContain('HTTP 500')
  })

  it('lets the caller redact the recorded error', async () => {
    const outcomes = await fetchAll([sources[1]!], {
      now: NOW,
      env: {},
      timeoutMs: 1000,
      fetchImpl: async () => {
        throw new Error('failed with key=supersecretvalue')
      },
      onError: (_name, err) => String((err as Error).message).replace(/key=\S+/, 'key=[REDACTED]'),
    })
    expect(outcomes[0]!.error).not.toContain('supersecretvalue')
  })
})
