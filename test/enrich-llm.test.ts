import { describe, expect, it, vi } from 'vitest'
import { llmSchema } from '../src/config/schema'
import {
  chatUrl,
  createLlmClient,
  LlmError,
  resolveProvider,
  type LlmFetch,
} from '../src/enrich/llm'

const provider = (overrides: Record<string, unknown> = {}) =>
  llmSchema.parse({ provider: { retries: 2, ...overrides } }).provider

function ok(body: unknown) {
  return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) }
}
function status(code: number, body = '{}') {
  return { ok: false, status: code, text: () => Promise.resolve(body) }
}

const ANSWER = { choices: [{ message: { content: '{"summary":"x"}' } }] }

/** Never really sleeps — a retry test that waits 1.5s is a test nobody runs. */
const noSleep = () => Promise.resolve()

function client(
  fetchImpl: LlmFetch,
  overrides: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
) {
  return createLlmClient({
    provider: resolveProvider(provider(overrides), env),
    apiKey: 'sk-test-key-value',
    fetchImpl,
    sleep: noSleep,
  })
}

describe('chatUrl', () => {
  it('appends the completions path', () => {
    expect(chatUrl('https://api.deepseek.com/v1')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    )
  })

  it('does not double the slash', () => {
    expect(chatUrl('https://x.example/v1/')).toBe('https://x.example/v1/chat/completions')
  })
})

describe('createLlmClient — the request', () => {
  it('sends the model, temperature and both messages, with the key as a bearer', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(ok(ANSWER))) as unknown as LlmFetch
    await client(fetchImpl).complete('SYSTEM', 'USER')
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer sk-test-key-value')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ model: 'deepseek-v4-flash', temperature: 0, max_tokens: 300 })
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'USER' },
    ])
  })

  it('LLM_BASE_URL wins over the configured baseUrl', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(ok(ANSWER))) as unknown as LlmFetch
    await client(fetchImpl, {}, { LLM_BASE_URL: 'https://self-hosted.example/openai/v1' }).complete(
      's',
      'u',
    )
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      'https://self-hosted.example/openai/v1/chat/completions',
    )
  })

  it('an empty LLM_BASE_URL falls back to the config rather than to nothing', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(ok(ANSWER))) as unknown as LlmFetch
    await client(fetchImpl, {}, { LLM_BASE_URL: '   ' }).complete('s', 'u')
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(
      'api.deepseek.com',
    )
  })

  it('LLM_MODEL wins over the configured model, and the client reports the one it sent', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(ok(ANSWER))) as unknown as LlmFetch
    const c = client(fetchImpl, {}, { LLM_MODEL: 'kimi-k2' })
    await c.complete('s', 'u')
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body,
    )
    expect(body.model).toBe('kimi-k2')
    // The provenance written into every archived item must name the model actually billed.
    expect(c.model).toBe('kimi-k2')
  })

  it('merges extraBody into the request body — thinking mode without a code change', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(ok(ANSWER))) as unknown as LlmFetch
    await client(fetchImpl, {
      extraBody: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
    }).complete('SYSTEM', 'USER')
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    const body = JSON.parse(init.body)
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('low')
    // and the four it must not disturb
    expect(body).toMatchObject({ model: 'deepseek-v4-flash', temperature: 0, max_tokens: 300 })
    expect(body.messages).toHaveLength(2)
  })

  it('sends no extra keys when extraBody is left empty', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(ok(ANSWER))) as unknown as LlmFetch
    await client(fetchImpl).complete('SYSTEM', 'USER')
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'temperature',
    ])
  })

  it('rejects an extraBody that would shadow a field the provider owns', () => {
    for (const key of ['model', 'messages', 'temperature', 'max_tokens', 'stream']) {
      expect(() => llmSchema.parse({ provider: { extraBody: { [key]: 'x' } } })).toThrow(
        new RegExp(key.replace(/_/g, '_')),
      )
    }
  })
})

describe('resolveProvider', () => {
  it('leaves the config alone when neither override is set', () => {
    const p = provider()
    expect(resolveProvider(p, {})).toBe(p)
  })

  it('overrides endpoint and model together — the swap a provider change actually needs', () => {
    const p = resolveProvider(provider(), {
      LLM_BASE_URL: 'https://api.moonshot.cn/v1',
      LLM_MODEL: 'kimi-k2',
    })
    expect(p).toMatchObject({ baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2' })
  })

  it('overriding one leaves the other on the config value', () => {
    expect(resolveProvider(provider(), { LLM_MODEL: 'deepseek-reasoner' })).toMatchObject({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-reasoner',
    })
  })

  it('a blank LLM_MODEL is "not set", never an empty model name', () => {
    expect(resolveProvider(provider(), { LLM_MODEL: '  ' }).model).toBe('deepseek-v4-flash')
  })

  it('keeps every field the overrides do not name', () => {
    const p = resolveProvider(provider({ concurrency: 3 }), { LLM_MODEL: 'x' })
    expect(p).toMatchObject({ apiKeyRef: 'LLM_API_KEY', temperature: 0, concurrency: 3 })
  })

  it('LLM_CONCURRENCY overrides on its own — a free tier at 1 QPS needs no config edit', () => {
    expect(resolveProvider(provider(), { LLM_CONCURRENCY: '1' })).toMatchObject({
      model: 'deepseek-v4-flash',
      concurrency: 1,
    })
  })

  it('ignores an LLM_CONCURRENCY that is not a whole number in range', () => {
    for (const value of ['0', '17', '2.5', 'four', '', '  ']) {
      expect(resolveProvider(provider(), { LLM_CONCURRENCY: value }).concurrency).toBe(4)
    }
  })

  it('carries extraBody through untouched', () => {
    const p = resolveProvider(provider({ extraBody: { reasoning_effort: 'low' } }), {
      LLM_MODEL: 'x',
    })
    expect(p.extraBody).toEqual({ reasoning_effort: 'low' })
  })
})

describe('createLlmClient — the response', () => {
  it('returns the content and the usage counters', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        ok({ ...ANSWER, usage: { prompt_tokens: 120, completion_tokens: 40 } }),
      )) as LlmFetch
    const result = await client(fetchImpl).complete('s', 'u')
    expect(result.content).toBe('{"summary":"x"}')
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 40 })
    expect(result.attempts).toBe(1)
  })

  it('an endpoint that reports no usage is not an error', async () => {
    const fetchImpl = (() => Promise.resolve(ok(ANSWER))) as LlmFetch
    expect((await client(fetchImpl).complete('s', 'u')).usage).toBeUndefined()
  })

  it('rejects a non-JSON body', async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html>502</html>'),
      })) as LlmFetch
    await expect(client(fetchImpl).complete('s', 'u')).rejects.toThrow(/non-JSON/)
  })

  it('rejects an answer with no message content', async () => {
    const fetchImpl = (() => Promise.resolve(ok({ choices: [{ message: {} }] }))) as LlmFetch
    await expect(client(fetchImpl).complete('s', 'u')).rejects.toThrow(/no message content/)
  })

  it('surfaces an endpoint error carried inside a 200', async () => {
    const fetchImpl = (() =>
      Promise.resolve(ok({ error: { message: 'insufficient balance' } }))) as LlmFetch
    await expect(client(fetchImpl).complete('s', 'u')).rejects.toThrow(/insufficient balance/)
  })
})

describe('createLlmClient — retries', () => {
  it('retries a 500 and returns the answer that eventually lands', async () => {
    let calls = 0
    const fetchImpl = (() => {
      calls++
      return Promise.resolve(calls < 3 ? status(500) : ok(ANSWER))
    }) as LlmFetch
    const result = await client(fetchImpl).complete('s', 'u')
    expect(calls).toBe(3)
    expect(result.attempts).toBe(3)
  })

  it('gives up after `retries` and reports the status', async () => {
    let calls = 0
    const fetchImpl = (() => {
      calls++
      return Promise.resolve(status(503))
    }) as LlmFetch
    await expect(client(fetchImpl).complete('s', 'u')).rejects.toThrow('HTTP 503')
    expect(calls).toBe(3) // the first try plus retries: 2
  })

  it('retries a 429', async () => {
    let calls = 0
    const fetchImpl = (() => {
      calls++
      return Promise.resolve(calls === 1 ? status(429) : ok(ANSWER))
    }) as LlmFetch
    await client(fetchImpl).complete('s', 'u')
    expect(calls).toBe(2)
  })

  it('does NOT retry a 401 — a bad key is bad three times too', async () => {
    let calls = 0
    const fetchImpl = (() => {
      calls++
      return Promise.resolve(status(401))
    }) as LlmFetch
    await expect(client(fetchImpl).complete('s', 'u')).rejects.toThrow('HTTP 401')
    expect(calls).toBe(1)
  })

  it('retries a network error / abort', async () => {
    let calls = 0
    const fetchImpl = (() => {
      calls++
      if (calls === 1) return Promise.reject(new Error('The operation was aborted'))
      return Promise.resolve(ok(ANSWER))
    }) as LlmFetch
    await client(fetchImpl).complete('s', 'u')
    expect(calls).toBe(2)
  })

  it('retries: 0 means exactly one attempt', async () => {
    let calls = 0
    const fetchImpl = (() => {
      calls++
      return Promise.resolve(status(500))
    }) as LlmFetch
    await expect(client(fetchImpl, { retries: 0 }).complete('s', 'u')).rejects.toBeInstanceOf(
      LlmError,
    )
    expect(calls).toBe(1)
  })

  it('never puts the error body — which quotes the request — into the message', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        status(400, JSON.stringify({ error: 'bad request', echo: 'Bearer sk-test-key-value' })),
      )) as LlmFetch
    await expect(client(fetchImpl).complete('s', 'u')).rejects.toThrow(/^HTTP 400$/)
  })
})
