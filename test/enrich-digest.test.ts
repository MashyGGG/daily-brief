import { describe, expect, it } from 'vitest'
import { llmSchema, type LlmConfig } from '../src/config/schema'
import type { BriefSection } from '../src/core/brief'
import { enrichSections } from '../src/enrich'
import { buildDigestEntries, estimateDigestTokens, generateDigest } from '../src/enrich/digest'
import { createLlmClient, type LlmFetch } from '../src/enrich/llm'
import { DIGEST_PROMPT_VERSION, FENCE_CLOSE, FENCE_OPEN } from '../src/enrich/prompt'
import { sanitizeDigest } from '../src/enrich/sanitize'
import { item } from './helpers'

/**
 * §9 M3 — the whole-issue 导读. The rule under every case here is §6.1's: a digest that
 * fails costs the issue its opening paragraph and nothing else.
 */

const KEY = { LLM_API_KEY: 'sk-test-key-value' } as NodeJS.ProcessEnv

function llm(overrides: Record<string, unknown> = {}): LlmConfig {
  return llmSchema.parse({
    enabled: true,
    provider: { retries: 0, concurrency: 2 },
    digest: { enabled: true },
    ...overrides,
  })
}

function answering(content: string, capture?: string[]): LlmFetch {
  return (_url, init) => {
    capture?.push(init.body)
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            choices: [{ message: { content } }],
            usage: { prompt_tokens: 400, completion_tokens: 90 },
          }),
        ),
    })
  }
}

const DIGEST_ANSWER = '{"digest":"今天最值得看的是 GitHub 的故障复盘。"}'

const twoSections = (): BriefSection[] => [
  {
    id: 'tech',
    title: '国际技术',
    items: [
      item({ id: 'a', title: 'GitHub outage', summary: 'LLM 写的摘要', excerpt: '334 points' }),
      item({ id: 'b', title: 'Rust 1.90', excerpt: '源自带摘要' }),
    ],
  },
  { id: 'ai', title: 'AI', items: [item({ id: 'c', title: 'DeepSeek', section: 'ai' })] },
]

const client = (fetchImpl: LlmFetch) =>
  createLlmClient({
    provider: llm().provider,
    apiKey: 'sk-test-key-value',
    fetchImpl,
    sleep: () => Promise.resolve(),
  })

describe('buildDigestEntries — what the digest is allowed to see', () => {
  it('prefers the LLM summary and falls back to the excerpt', () => {
    const entries = buildDigestEntries(twoSections(), llm().digest)
    expect(entries[0]).toEqual({
      section: '国际技术',
      title: 'GitHub outage',
      body: 'LLM 写的摘要',
    })
    expect(entries[1]!.body).toBe('源自带摘要')
  })

  it('an item with neither still contributes its title', () => {
    const entries = buildDigestEntries(twoSections(), llm().digest)
    expect(entries[2]).toEqual({ section: 'AI', title: 'DeepSeek', body: '' })
  })

  it('caps at maxItems, walking sections in order', () => {
    const entries = buildDigestEntries(twoSections(), llm({ digest: { maxItems: 2 } }).digest)
    expect(entries.map((e) => e.title)).toEqual(['GitHub outage', 'Rust 1.90'])
  })

  it('cuts each item to maxCharsPerItem — the input is bounded before anything is spent', () => {
    const long = [{ id: 'x', title: '标题', summary: '中'.repeat(500) }].map((i) => item(i))
    const entries = buildDigestEntries(
      [{ id: 'tech', title: '国际技术', items: long }],
      llm({ digest: { maxCharsPerItem: 40 } }).digest,
    )
    expect([...entries[0]!.body].length).toBe(40)
  })

  it('estimates tokens without calling anything', () => {
    expect(estimateDigestTokens(buildDigestEntries(twoSections(), llm().digest))).toBeGreaterThan(0)
  })
})

describe('sanitizeDigest — §6.2 applies to the digest exactly as to a summary', () => {
  it('reads {"digest": …}', () => {
    expect(sanitizeDigest(DIGEST_ANSWER, 240)).toBe('今天最值得看的是 GitHub 的故障复盘。')
  })

  it('accepts {"summary": …} — the field a model reaches for when told "summarize"', () => {
    expect(sanitizeDigest('{"summary":"三件事"}', 240)).toBe('三件事')
  })

  it('accepts bare prose from a model that ignored the JSON instruction', () => {
    expect(sanitizeDigest('今天有三件事值得看。', 240)).toBe('今天有三件事值得看。')
  })

  it('strips links: the digest is committed to a public repo', () => {
    expect(
      sanitizeDigest('{"digest":"详见 https://evil.example.com/x 的说明"}', 240),
    ).not.toContain('evil')
  })

  it('enforces maxChars whatever the prompt asked for', () => {
    expect([...sanitizeDigest(`{"digest":"${'字'.repeat(400)}"}`, 60)].length).toBeLessThanOrEqual(
      60,
    )
  })

  it('empty JSON is no digest, not an empty one', () => {
    expect(sanitizeDigest('{"digest":""}', 240)).toBe('')
  })
})

describe('generateDigest — one call, isolated', () => {
  it('fences the item list and records its own prompt version', async () => {
    const bodies: string[] = []
    const outcome = await generateDigest(
      twoSections(),
      llm(),
      client(answering(DIGEST_ANSWER, bodies)),
      (err) => String(err),
    )
    expect(outcome.digest!.text).toBe('今天最值得看的是 GitHub 的故障复盘。')
    expect(outcome.digest!.meta).toEqual({
      by: 'llm',
      model: 'deepseek-chat',
      promptVersion: DIGEST_PROMPT_VERSION,
      inputKind: 'summaries',
    })
    const user = JSON.parse(bodies[0]!).messages[1].content as string
    expect(user).toContain(FENCE_OPEN)
    expect(user).toContain(FENCE_CLOSE)
    expect(user).toContain('【国际技术】')
  })

  it('a thrown call degrades to no digest and a reported reason', async () => {
    const outcome = await generateDigest(
      twoSections(),
      llm(),
      client(() => Promise.reject(new Error('endpoint down'))),
      (err) => (err as Error).message,
    )
    expect(outcome.digest).toBeNull()
    expect(outcome.failure).toBe('endpoint down')
  })

  it('an unusable answer is a failure, not an empty digest', async () => {
    const outcome = await generateDigest(
      twoSections(),
      llm(),
      client(answering('{"digest":"   "}')),
      String,
    )
    expect(outcome.digest).toBeNull()
    expect(outcome.failure).toBe('model returned nothing usable')
  })

  it('nothing to digest is not a call', async () => {
    const outcome = await generateDigest([], llm(), client(answering(DIGEST_ANSWER)), String)
    expect(outcome).toMatchObject({ digest: null, attempts: 0, failure: null })
  })
})

describe('the digest inside the enrich stage', () => {
  const ctx = (fetchImpl: LlmFetch, over: Record<string, unknown> = {}) => ({
    env: KEY,
    fetchImpl,
    sleep: () => Promise.resolve(),
    ...over,
  })

  it('runs last, so it sees the summaries this run produced', async () => {
    const bodies: string[] = []
    const fetchImpl: LlmFetch = (url, init) => {
      bodies.push(init.body)
      const isDigest = init.body.includes('【国际技术】')
      return answering(
        isDigest ? DIGEST_ANSWER : '{"summary":"新的借用检查器","takeaways":["更快"]}',
      )(url, init)
    }
    const result = await enrichSections(
      [{ id: 'tech', title: '国际技术', items: [item({ id: 'a', excerpt: 'Comments' })] }],
      llm({ sections: { tech: { summarize: true } } }),
      ctx(fetchImpl),
    )
    expect(result.sections[0]!.items[0]!.summary).toBe('新的借用检查器')
    expect(result.digest!.text).toBe('今天最值得看的是 GitHub 的故障复盘。')
    expect(result.stats.digest).toBe('ok')
    // The digest call is the last one, and it carries the summary the first one produced.
    expect(bodies[bodies.length - 1]).toContain('新的借用检查器')
  })

  it('still runs when every item was gated out — the issue still has a "what matters"', async () => {
    const result = await enrichSections(
      [{ id: 'tech', title: '国际技术', items: [item({ id: 'a', excerpt: '一个足够好的摘要' })] }],
      // No section opted in, so `summarize` is false for every item.
      llm(),
      ctx(answering(DIGEST_ANSWER)),
    )
    expect(result.stats.planned).toBe(0)
    expect(result.stats.digest).toBe('ok')
    expect(result.digest).toBeDefined()
  })

  it('a failed digest writes a warning and leaves the items alone (§6.1)', async () => {
    const result = await enrichSections(
      [{ id: 'tech', title: '国际技术', items: [item({ id: 'a', excerpt: 'x' })] }],
      llm(),
      ctx(() => Promise.reject(new Error('502 upstream'))),
    )
    expect(result.digest).toBeUndefined()
    expect(result.stats.digest).toBe('failed')
    expect(result.warnings.join('\n')).toContain('502 upstream')
    expect(result.sections[0]!.items[0]!.summary).toBeUndefined()
  })

  it('--llm-dry-run plans the digest and calls nothing', async () => {
    const logs: string[] = []
    let called = 0
    const result = await enrichSections(
      [{ id: 'tech', title: '国际技术', items: [item({ id: 'a' })] }],
      llm(),
      ctx(
        () => {
          called++
          return Promise.reject(new Error('must not be called'))
        },
        { planOnly: true, log: (m: string) => logs.push(m) },
      ),
    )
    expect(called).toBe(0)
    expect(result.stats.digest).toBe('planned')
    expect(result.stats.estimatedDigestTokens).toBeGreaterThan(0)
    expect(logs.join('\n')).toContain('llm-dry-run: digest')
  })

  it('digestOnly summarizes no item — the weekly does not pay twice', async () => {
    let calls = 0
    const fetchImpl: LlmFetch = (url, init) => {
      calls++
      return answering(DIGEST_ANSWER)(url, init)
    }
    const result = await enrichSections(
      [{ id: 'tech', title: '国际技术', items: [item({ id: 'a', excerpt: 'Comments' })] }],
      llm({ sections: { tech: { summarize: true } } }),
      ctx(fetchImpl, { digestOnly: true }),
    )
    expect(calls).toBe(1)
    expect(result.stats.planned).toBe(0)
    expect(result.digest).toBeDefined()
  })

  it('llm.digest.enabled=false means no digest and no call', async () => {
    let called = 0
    const result = await enrichSections(
      [{ id: 'tech', title: '国际技术', items: [item({ id: 'a', excerpt: '够好了' })] }],
      llm({ digest: { enabled: false } }),
      ctx(() => {
        called++
        return Promise.reject(new Error('must not be called'))
      }),
    )
    expect(called).toBe(0)
    expect(result.stats.status).toBe('nothing')
    expect(result.stats.digest).toBe('off')
  })

  it('no key: no digest, no warning — not configured is not a failure', async () => {
    const result = await enrichSections(
      [{ id: 'tech', title: '国际技术', items: [item({ id: 'a' })] }],
      llm(),
      { env: {}, fetchImpl: answering(DIGEST_ANSWER), sleep: () => Promise.resolve() },
    )
    expect(result.stats.status).toBe('no-key')
    expect(result.digest).toBeUndefined()
    expect(result.warnings).toEqual([])
  })
})
