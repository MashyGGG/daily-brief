import type { LlmConfig } from '../config/schema'

/**
 * A minimal OpenAI-compatible chat client. Deliberately not the vendor SDK: the config
 * promises "any OpenAI-compatible endpoint", and one POST plus a lenient parse is the
 * whole contract that promise rests on.
 *
 * `fetchImpl` is injected exactly as in `sources/types.ts`, so every test here runs
 * against a hand-written response and no test opens a socket.
 */

export interface LlmHttpResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type LlmFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
  },
) => Promise<LlmHttpResponse>

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
}

export interface LlmCompletion {
  content: string
  usage?: LlmUsage
  /** How many HTTP attempts this answer cost, including the one that worked. */
  attempts: number
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

/** 429 and 5xx are the endpoint saying "later"; 4xx is it saying "no". */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

export function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

interface ChatResponse {
  choices?: { message?: { content?: unknown } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string }
}

export interface LlmClientOptions {
  provider: LlmConfig['provider']
  apiKey: string
  /** `LLM_BASE_URL` — swapping provider without touching the committed config. */
  baseUrl?: string
  fetchImpl: LlmFetch
  /** Injected so a retry costs the tests nothing. */
  sleep?: (ms: number) => Promise<void>
}

export interface LlmClient {
  readonly model: string
  complete(system: string, user: string): Promise<LlmCompletion>
}

/** Base delay for the retry backoff; doubled per attempt. */
export const RETRY_BASE_MS = 500

export function createLlmClient(options: LlmClientOptions): LlmClient {
  const { provider, apiKey, fetchImpl } = options
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const url = chatUrl(options.baseUrl?.trim() || provider.baseUrl)

  async function once(system: string, user: string): Promise<LlmCompletion> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), provider.timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          temperature: provider.temperature,
          max_tokens: provider.maxOutputTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      })
      const body = await res.text()
      if (!res.ok) {
        // The body of an error response can quote the request, which quotes the key.
        // It never reaches a warning: the caller redacts, and we only keep the status.
        throw new LlmError(`HTTP ${res.status}`, res.status, retryableStatus(res.status))
      }
      let parsed: ChatResponse
      try {
        parsed = JSON.parse(body) as ChatResponse
      } catch {
        throw new LlmError('endpoint returned a non-JSON body')
      }
      if (parsed.error?.message) throw new LlmError(`endpoint error: ${parsed.error.message}`)
      const content = parsed.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.trim() === '') {
        throw new LlmError('endpoint returned no message content')
      }
      const usage =
        parsed.usage &&
        (typeof parsed.usage.prompt_tokens === 'number' ||
          typeof parsed.usage.completion_tokens === 'number')
          ? {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
            }
          : undefined
      return { content, usage, attempts: 1 }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    model: provider.model,
    async complete(system: string, user: string): Promise<LlmCompletion> {
      let last: unknown
      for (let attempt = 0; attempt <= provider.retries; attempt++) {
        try {
          const result = await once(system, user)
          return { ...result, attempts: attempt + 1 }
        } catch (err) {
          last = err
          // A network error or an abort (the timeout firing) is worth one more try; a
          // hard 4xx is not — retrying a bad key just spends the clock three times over.
          const retryable = err instanceof LlmError ? err.retryable : true
          if (!retryable || attempt === provider.retries) break
          await sleep(RETRY_BASE_MS * 2 ** attempt)
        }
      }
      throw last instanceof Error ? last : new LlmError(String(last))
    },
  }
}
