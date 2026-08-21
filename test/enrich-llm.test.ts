import { describe, expect, it, vi } from 'vitest'
import { llmSchema } from '../src/config/schema'
import { chatUrl, createLlmClient, LlmError, type LlmFetch } from '../src/enrich/llm'

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

function client(fetchImpl: LlmFetch, overrides: Record<string, unknown> = {}, baseUrl?: string) {
  return createLlmClient({
    provider: provider(overrides),
    apiKey: 'sk-test-key-value',
    baseUrl,
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
    expect(body).toMatchObject({ model: 'deepseek-chat', temperature: 0, max_tokens: 300 })
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'USER' },
    ])
  })

  it('LLM_BASE_URL wins over the configured baseUrl', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(ok(ANSWER))) as unknown as LlmFetch
    await client(fetchImpl, {}, 'https://self-hosted.example/openai/v1').complete('s', 'u')
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      'https://self-hosted.example/openai/v1/chat/completions',
    )
  })

  it('an empty LLM_BASE_URL falls back to the config rather than to nothing', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(ok(ANSWER))) as unknown as LlmFetch
    await client(fetchImpl, {}, '   ').complete('s', 'u')
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(
      'api.deepseek.com',
    )
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
