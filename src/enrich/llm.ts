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

/**
 * `LLM_BASE_URL` / `LLM_MODEL` — swapping provider without a commit. The two override
 * together on purpose: a new endpoint still answering to the old model name is a 401 or a
 * 404 every morning at 07:10, and the config would still claim the old model was in use.
 * Blank means "not set" rather than "set to nothing", exactly as the config-vs-secret
 * convention reads everywhere else in this repo.
 *
 * `LLM_CONCURRENCY` rides along for a third reason: rate limits belong to the key, not to
 * the config. A free tier at ~1 QPS answers `concurrency: 4` with a wall of 429s, and an
 * A/B run that degrades half its items to excerpts compares nothing. Unparseable or
 * out-of-range values are ignored rather than fatal — a bad env var must not take the
 * morning brief down.
 */
export function resolveProvider(
  provider: LlmConfig['provider'],
  env: NodeJS.ProcessEnv,
): LlmConfig['provider'] {
  const baseUrl = env.LLM_BASE_URL?.trim()
  const model = env.LLM_MODEL?.trim()
  const raw = Number(env.LLM_CONCURRENCY?.trim())
  const concurrency = Number.isInteger(raw) && raw >= 1 && raw <= 16 ? raw : undefined
  if (!baseUrl && !model && concurrency === undefined) return provider
  return {
    ...provider,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
  }
}

export interface LlmClientOptions {
  /** Already through `resolveProvider`, so `model` here is the model actually billed. */
  provider: LlmConfig['provider']
  apiKey: string
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
  const url = chatUrl(provider.baseUrl)

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
          // Vendor extensions — thinking mode, tools — straight through. The schema rejects
          // the keys above, so this can add to the request but never rewrite it.
          ...provider.extraBody,
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
