import { describe, expect, it, vi } from 'vitest'
import { parseFeed } from '../src/sources/rss'
import { buildHnUrl, parseHnHits } from '../src/sources/hackernews'
import { buildGithubUrl, parseRepos } from '../src/sources/github'
import { fetchAll, type FetchContext } from '../src/sources'
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
    { name: 'good', type: 'rss', weight: 1, params: { url: 'https://a.com/rss', limit: 50 } },
    { name: 'bad', type: 'rss', weight: 1, params: { url: 'https://b.com/rss', limit: 50 } },
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
