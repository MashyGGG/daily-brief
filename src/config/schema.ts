import { z } from 'zod'
import { parse as parseYaml } from 'yaml'

/**
 * §1.2 — where a `summary` came from, kept so a prompt change can be evaluated against
 * yesterday's archive instead of waiting for tomorrow's run (`--re-enrich`).
 */
export interface SummaryMeta {
  /** Only ever `llm`: an item with no LLM summary carries no meta at all. */
  by: 'llm'
  model: string
  promptVersion: string
  /** M1 always writes `excerpt`; M2's full-text fetch is what makes this worth recording. */
  inputKind: 'excerpt' | 'fulltext'
}

/** §2.1 — every source normalizes to this shape; it is also the archive JSON element. */
export interface Item {
  id: string
  title: string
  url: string
  source: string
  section: string
  publishedAt: string
  score?: number
  rankScore: number
  author?: string
  /**
   * The source's own description, cleaned. Never overwritten by the LLM: `filter.ts`
   * matches `include`/`exclude` against it, so rewriting it would silently drift the
   * editorial rules, and keeping it is what makes the no-LLM degradation free.
   */
  excerpt?: string
  /** §1.2 — LLM output, rendered in preference to `excerpt`. */
  summary?: string
  takeaways?: string[]
  summaryMeta?: SummaryMeta
}

/** An item before ranking / section assignment. */
export type RawItem = Omit<Item, 'section' | 'rankScore'>

export const RESEND_SANDBOX_FROM = 'onboarding@resend.dev'

const ID = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, 'must be alphanumeric/dash')

const WILDCARD_LIST = z.array(z.string().min(1)).min(1)

const TIME = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "must be local time 'HH:MM' (24h)")

export const scheduleSchema = z.object({
  id: ID,
  time: TIME,
  lookbackHours: z
    .number()
    .positive()
    .max(24 * 14)
    .default(24),
  sections: WILDCARD_LIST.default(['*']),
  recipients: WILDCARD_LIST.default(['*']),
  enabled: z.boolean().default(true),
})

/**
 * §3.2 — how many days of silence make a source *suspicious* rather than merely quiet.
 * A feed that answers 200 with month-old content looks identical to a healthy one until
 * you name that budget, so every source has one. The default suits anything that publishes
 * at least monthly; slower sources declare their own (measured cadences: docs/SOURCES.md).
 */
export const DEFAULT_STALE_AFTER_DAYS = 30
const STALE_AFTER_DAYS = z
  .number()
  .int()
  .positive()
  .max(365 * 10)
  .optional()

/**
 * Boilerplate the feed glues onto every title and excerpt — `appeared first on The GitHub
 * Blog`, `点击查看原文`, a bare `Comments`, a trailing ` - thepaper.cn`. Case-insensitive
 * JavaScript regexes, applied before truncation.
 *
 * These also feed the title-similarity check (`dedupe.titleSimilarity`): measured on the
 * 08-20/08-21 archives, a shared source suffix scored *higher* (0.327) than a genuine
 * cross-post of the same story (0.306), so leaving the boilerplate in makes near-dupe
 * detection actively wrong rather than merely noisy.
 */
const REGEX = z
  .string()
  .min(1)
  .refine((p) => {
    try {
      new RegExp(p, 'gi')
      return true
    } catch {
      return false
    }
  }, 'must be a valid JavaScript regular expression')

const STRIP_PATTERNS = z.array(REGEX).default([])

export const sourceSchema = z.discriminatedUnion('type', [
  z.object({
    name: ID,
    type: z.literal('rss'),
    weight: z.number().positive().default(1),
    staleAfterDays: STALE_AFTER_DAYS,
    stripPatterns: STRIP_PATTERNS,
    params: z.object({
      url: z.string().url(),
      limit: z.number().int().positive().max(200).default(50),
    }),
  }),
  z.object({
    name: ID,
    type: z.literal('hackernews'),
    weight: z.number().positive().default(1),
    staleAfterDays: STALE_AFTER_DAYS,
    stripPatterns: STRIP_PATTERNS,
    params: z.object({
      mode: z.enum(['front_page', 'new', 'show_hn']).default('front_page'),
      minPoints: z.number().int().nonnegative().default(0),
      limit: z.number().int().positive().max(200).default(50),
    }),
  }),
  z.object({
    name: ID,
    type: z.literal('github'),
    weight: z.number().positive().default(1),
    staleAfterDays: STALE_AFTER_DAYS,
    stripPatterns: STRIP_PATTERNS,
    params: z.object({
      language: z.string().min(1).optional(),
      query: z.string().min(1).optional(),
      createdWithinDays: z.number().int().positive().max(365).default(7),
      minStars: z.number().int().nonnegative().default(0),
      limit: z.number().int().positive().max(100).default(30),
    }),
  }),
])

export const sectionSchema = z.object({
  id: ID,
  title: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
  limit: z.number().int().positive('limit must be > 0'),
  minPerSource: z.number().int().nonnegative().default(0),
  include: z.array(z.string().min(1)).default([]),
  exclude: z.array(z.string().min(1)).default([]),
  /**
   * Retiring a section is one flag, not a deletion: the sources it names stay declared,
   * `--sections <id>` keeps validating, and turning it back on needs no cron regeneration.
   * Same semantics as `recipients[].enabled` — a disabled section is skipped even when
   * something names it explicitly.
   */
  enabled: z.boolean().default(true),
})

export const archiveSchema = z
  .object({
    enabled: z.boolean().default(true),
    dir: z.string().min(1).default('archive'),
    indexKeep: z.number().int().positive().default(30),
    commit: z.boolean().default(true),
    dedupeLookbackDays: z.number().int().positive().max(90).default(14),
  })
  .default({})

/**
 * §0.1 ② — an excerpt cut at exactly N characters lands mid-word half the time.
 * `excerptMaxChars` is the budget; `toExcerpt` spends it down to the last sentence
 * boundary that fits, so the reader gets a whole thought or an honest ellipsis.
 */
export const renderSchema = z
  .object({
    excerptMaxChars: z.number().int().min(40).max(2000).default(300),
  })
  .default({})

/**
 * Near-duplicate titles. Exact-title dedupe misses the case that actually costs seats:
 * Chinese tech sites re-report each other's stories under freshly written headlines,
 * so one section spends two of its limit on one story.
 *
 * `titleSimilarity` is the Dice coefficient over character 4-grams of the normalized
 * title; `0` disables the check. Measured over the 08-20/08-21 archives (43 titles):
 * the one genuine cross-post scored 0.286, the highest-scoring unrelated pair 0.086 —
 * 0.2 sits inside that 3.3x gap. 4-grams and not 3: at n=3 the gap narrows to
 * 0.306 vs 0.153, and at n=2 it inverts (0.341 vs 0.444) and the check becomes harmful.
 */
export const dedupeSchema = z
  .object({
    titleSimilarity: z.number().min(0).max(1).default(0.2),
  })
  .default({})

/* ────────────────────────────── §2 the `llm` block ────────────────────────────── */

export const LLM_STYLES = ['bullet', 'oneline', 'tldr'] as const

/**
 * The knobs that resolve source → section → defaults, most specific winning. Every field
 * is optional here precisely so "unset" and "set to false" stay distinguishable — a
 * section saying `summarize: true` must not be overridden by a source that says nothing.
 */
const llmPolicyOverride = z.object({
  summarize: z.boolean().optional(),
  style: z.enum(LLM_STYLES).optional(),
  language: z.string().min(1).optional(),
  maxChars: z.number().int().min(40).max(1000).optional(),
  /** Declared here from M1 so configs need no edit at M2; until then `summaryMeta.inputKind` stays `excerpt`. */
  fetchFullText: z.boolean().optional(),
})

const llmDefaults = z
  .object({
    /** Whitelist, not blacklist: a source is silent about the LLM until someone opts it in. */
    summarize: z.boolean().default(false),
    style: z.enum(LLM_STYLES).default('bullet'),
    language: z.string().min(1).default('zh-CN'),
    maxChars: z.number().int().min(40).max(1000).default(180),
    fetchFullText: z.boolean().default(false),
  })
  .default({})

export const llmSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z
      .object({
        /** Any OpenAI-compatible `/chat/completions` endpoint; `LLM_BASE_URL` overrides it. */
        baseUrl: z.string().url().default('https://api.deepseek.com/v1'),
        /** `LLM_MODEL` overrides it — the pair moves with `baseUrl`, never alone. */
        model: z.string().min(1).default('deepseek-chat'),
        /** The NAME of the env var holding the key — same convention as `recipients[].secretRef`. */
        apiKeyRef: z.string().min(1).default('LLM_API_KEY'),
        temperature: z.number().min(0).max(2).default(0),
        maxOutputTokens: z.number().int().min(64).max(4096).default(300),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(120 * 1000)
          .default(30_000),
        concurrency: z.number().int().min(1).max(16).default(4),
        retries: z.number().int().min(0).max(5).default(2),
      })
      .default({}),
    /**
     * The hard gate. `section.limit` already caps how many items can reach the LLM at all
     * (§1.1 reason 2); this is the second bound, the one that holds when a config edit goes
     * wrong. Both are checked, and the smaller one wins by construction.
     */
    budget: z
      .object({
        maxItemsPerRun: z.number().int().min(0).max(200).default(12),
        maxInputCharsPerItem: z.number().int().min(100).max(50_000).default(6000),
        maxTotalInputChars: z.number().int().min(100).max(1_000_000).default(80_000),
      })
      .default({}),
    defaults: llmDefaults,
    sections: z.record(ID, llmPolicyOverride).default({}),
    sources: z.record(ID, llmPolicyOverride).default({}),
    /**
     * The quality gate — orthogonal to `summarize`. The switches say "is this KIND of
     * content worth paying for"; these say "is THIS item's own excerpt already good
     * enough". Leaving both `excerptShorterThan` and `excerptMatches` unset turns the
     * excerpt-quality half off entirely rather than rejecting everything.
     */
    when: z
      .object({
        /** Call only when the source excerpt is shorter than this. `0` = don't judge by length. */
        excerptShorterThan: z.number().int().nonnegative().default(0),
        /** …or when it matches a known-junk fingerprint. Case-insensitive, validated here. */
        excerptMatches: z.array(REGEX).default([]),
        /** Only the top N of each section, in rank order. `0` = no cap. */
        topPerSection: z.number().int().nonnegative().default(0),
        /**
         * Skip items whose title is already in this language. Note this ANDs with the
         * switches above, so setting `zh` silently cancels any `sections.cn-tech`
         * opt-in — which is why the shipped config leaves it unset.
         */
        titleLanguageNot: z.enum(['zh']).optional(),
      })
      .default({}),
  })
  .default({})

/**
 * A delivery target list: one target, a comma-separated string, or a real array.
 * Email uses it for several mailboxes; wxpusher for its uid list; telegram for a chat id.
 */
const TARGETS = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])

export const recipientSchema = z.object({
  id: ID,
  channel: z.enum(['wecom', 'email', 'serverchan', 'pushplus', 'wxpusher', 'telegram', 'stdout']),
  driver: z.enum(['smtp', 'resend']).optional(),
  secretRef: z.string().min(1).optional(),
  to: TARGETS.optional(),
  cc: TARGETS.optional(), // email only; ignored by every other channel
  sections: WILDCARD_LIST.default(['*']),
  format: z.enum(['markdown', 'html', 'text']).default('markdown'),
  enabled: z.boolean().default(true),
})

export type Schedule = z.infer<typeof scheduleSchema>
export type Source = z.infer<typeof sourceSchema>
export type Section = z.infer<typeof sectionSchema>
export type ArchiveConfig = z.infer<typeof archiveSchema>
export type RenderConfig = z.infer<typeof renderSchema>
export type DedupeConfig = z.infer<typeof dedupeSchema>
export type LlmConfig = z.infer<typeof llmSchema>
export type LlmPolicyOverride = z.infer<typeof llmPolicyOverride>
export type LlmStyle = (typeof LLM_STYLES)[number]
export type Recipient = z.infer<typeof recipientSchema>

/** Channels whose destination lives entirely inside a secret. */
const SECRET_REF_CHANNELS = new Set(['wecom', 'serverchan', 'pushplus', 'wxpusher', 'telegram'])

export const briefConfigSchema = z
  .object({
    timezone: z.string().min(1).default('Asia/Shanghai'),
    title: z.string().min(1).default('每日早报'),
    schedules: z.array(scheduleSchema).min(1),
    sources: z.array(sourceSchema).min(1),
    sections: z.array(sectionSchema).min(1),
    archive: archiveSchema,
    render: renderSchema,
    dedupe: dedupeSchema,
    llm: llmSchema,
    recipients: z.array(recipientSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const flagDupes = (ids: string[], path: string, key: string) => {
      const seen = new Set<string>()
      ids.forEach((id, i) => {
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path, i, key],
            message: `duplicate id "${id}"`,
          })
        }
        seen.add(id)
      })
    }

    flagDupes(
      cfg.schedules.map((s) => s.id),
      'schedules',
      'id',
    )
    flagDupes(
      cfg.sources.map((s) => s.name),
      'sources',
      'name',
    )
    flagDupes(
      cfg.sections.map((s) => s.id),
      'sections',
      'id',
    )
    flagDupes(
      cfg.recipients.map((r) => r.id),
      'recipients',
      'id',
    )

    const sourceNames = new Set(cfg.sources.map((s) => s.name))
    const sectionIds = new Set(cfg.sections.map((s) => s.id))
    const recipientIds = new Set(cfg.recipients.map((r) => r.id))

    cfg.sections.forEach((section, si) => {
      section.sources.forEach((name, i) => {
        if (!sourceNames.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['sections', si, 'sources', i],
            message: `section "${section.id}" references unknown source "${name}"`,
          })
        }
      })
    })

    // A typo'd key under `llm.sections` / `llm.sources` costs nothing at runtime and does
    // nothing at all — the override simply never matches. Catch it here instead.
    Object.keys(cfg.llm.sections).forEach((id) => {
      if (!sectionIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['llm', 'sections', id],
          message: `unknown section "${id}"`,
        })
      }
    })
    Object.keys(cfg.llm.sources).forEach((name) => {
      if (!sourceNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['llm', 'sources', name],
          message: `unknown source "${name}"`,
        })
      }
    })

    const checkRefs = (
      names: string[],
      known: Set<string>,
      path: (string | number)[],
      label: string,
    ) => {
      names.forEach((name, i) => {
        if (name === '*') return
        if (!known.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, i],
            message: `unknown ${label} "${name}"`,
          })
        }
      })
    }

    cfg.schedules.forEach((s, i) => {
      checkRefs(s.sections, sectionIds, ['schedules', i, 'sections'], 'section')
      checkRefs(s.recipients, recipientIds, ['schedules', i, 'recipients'], 'recipient')
    })

    cfg.recipients.forEach((r, i) => {
      checkRefs(r.sections, sectionIds, ['recipients', i, 'sections'], 'section')

      if (SECRET_REF_CHANNELS.has(r.channel) && !r.secretRef) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recipients', i, 'secretRef'],
          message: `recipient "${r.id}" (channel ${r.channel}) requires a secretRef`,
        })
      }
      if (r.channel === 'email') {
        // `to`/`cc` may legitimately be absent here and arrive as EMAIL_TO / EMAIL_CC;
        // the channel skips the recipient if neither ends up naming a mailbox.
        if (r.driver === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['recipients', i, 'driver'],
            message: `recipient "${r.id}" (channel email) requires driver: smtp | resend`,
          })
        }
      } else if (r.driver) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recipients', i, 'driver'],
          message: `"driver" only applies to channel email (recipient "${r.id}")`,
        })
      }
    })
  })

export type BriefConfig = z.infer<typeof briefConfigSchema>

export interface ConfigIssue {
  path: string
  message: string
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: ConfigIssue[] = [],
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

function formatIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length ? issue.path.join('.') : '(root)',
    message: issue.message,
  }))
}

export function renderIssues(issues: ConfigIssue[]): string {
  return issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')
}

/**
 * A malformed EMAIL_TO / EMAIL_CC secret should fail here — at startup, with the name of
 * the secret — rather than hours later inside the mailer. Absence is NOT an error: a
 * recipient with no mailbox is skipped by the channel like any other missing secret.
 */
function assertEmailSecrets(env: NodeJS.ProcessEnv) {
  targetList(env.EMAIL_TO, 'EMAIL_TO')
  targetList(env.EMAIL_CC, 'EMAIL_CC')
}

/**
 * §3.1 rule 4 (A15): the resend driver only works against a verified custom domain.
 * Left on the shared sandbox sender it silently delivers to exactly one inbox.
 */
function assertResendSender(cfg: BriefConfig, env: NodeJS.ProcessEnv) {
  const issues: ConfigIssue[] = []
  cfg.recipients.forEach((r, i) => {
    if (r.channel !== 'email' || r.driver !== 'resend' || !r.enabled) return
    const from = (env.EMAIL_FROM ?? '').trim()
    if (from === '' || from.toLowerCase().endsWith(RESEND_SANDBOX_FROM)) {
      issues.push({
        path: `recipients.${i}.driver`,
        message:
          `recipient "${r.id}" uses driver "resend" while EMAIL_FROM is "${from || '(unset)'}". ` +
          `Resend's shared sender ${RESEND_SANDBOX_FROM} is a sandbox: it can only deliver to the ` +
          `address that registered the Resend account, so every other recipient silently never ` +
          `arrives. Verify your own domain and set EMAIL_FROM to it, or use driver: smtp.`,
      })
    }
  })
  if (issues.length) {
    throw new ConfigError('Invalid brief.config.yaml:\n' + renderIssues(issues), issues)
  }
}

/**
 * §3.1 rule 3 — private recipients that must not be committed arrive as
 * RECIPIENTS_OVERRIDE_JSON and are merged over the YAML list by `id`.
 */
export function applyRecipientOverride(cfg: BriefConfig, raw: string | undefined): BriefConfig {
  if (!raw || raw.trim() === '') return cfg
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(`RECIPIENTS_OVERRIDE_JSON is not valid JSON: ${(err as Error).message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError('RECIPIENTS_OVERRIDE_JSON must be a JSON array of recipients')
  }
  const merged = [...cfg.recipients]
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Recipient).id !== 'string'
    ) {
      throw new ConfigError('RECIPIENTS_OVERRIDE_JSON entries must be objects carrying an "id"')
    }
    const id = (entry as Recipient).id
    const at = merged.findIndex((r) => r.id === id)
    const base = at >= 0 ? merged[at] : undefined
    const candidate = { ...(base ?? {}), ...(entry as Record<string, unknown>) }
    const result = recipientSchema.safeParse(candidate)
    if (!result.success) {
      const issues = formatIssues(result.error).map((i) => ({
        path: `RECIPIENTS_OVERRIDE_JSON.${id}.${i.path}`,
        message: i.message,
      }))
      throw new ConfigError('Invalid RECIPIENTS_OVERRIDE_JSON:\n' + renderIssues(issues), issues)
    }
    if (at >= 0) merged[at] = result.data
    else merged.push(result.data)
  }
  return { ...cfg, recipients: merged }
}

/** Parse + validate YAML text. Invalid config throws — it is never silently skipped. */
export function parseConfig(yamlText: string, env: NodeJS.ProcessEnv = process.env): BriefConfig {
  let doc: unknown
  try {
    doc = parseYaml(yamlText)
  } catch (err) {
    throw new ConfigError(`brief.config.yaml is not valid YAML: ${(err as Error).message}`)
  }
  const result = briefConfigSchema.safeParse(doc)
  if (!result.success) {
    const issues = formatIssues(result.error)
    throw new ConfigError('Invalid brief.config.yaml:\n' + renderIssues(issues), issues)
  }
  const withOverride = applyRecipientOverride(result.data, env.RECIPIENTS_OVERRIDE_JSON)
  // Re-run cross-field validation so overridden recipients cannot dodge the reference checks.
  const revalidated = briefConfigSchema.safeParse(withOverride)
  if (!revalidated.success) {
    const issues = formatIssues(revalidated.error)
    throw new ConfigError(
      'Invalid config after RECIPIENTS_OVERRIDE_JSON merge:\n' + renderIssues(issues),
      issues,
    )
  }
  assertEmailSecrets(env)
  assertResendSender(revalidated.data, env)
  return revalidated.data
}

export function resolveSections(names: string[], all: Section[]): Section[] {
  if (names.includes('*')) return all
  return all.filter((s) => names.includes(s.id))
}

/**
 * Read a recipient's `to` — always through this, never directly: it may be a single
 * target, a comma-separated list, or an array, and every caller wants the same list.
 */
export function targetList(to: string | string[] | undefined, label = 'to'): string[] {
  if (to === undefined) return []
  if (Array.isArray(to)) return to.map((t) => t.trim()).filter(Boolean)
  const trimmed = to.trim()
  // A GitHub secret can only hold a string, so a list arrives either as JSON or
  // comma-separated. Anything starting with "[" is meant as JSON: parse it strictly
  // rather than comma-splitting it into `["a@x.com` and friends.
  if (trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new ConfigError(`${label} looks like a JSON array but does not parse: ${trimmed}`)
    }
    if (!Array.isArray(parsed) || parsed.some((t) => typeof t !== 'string')) {
      throw new ConfigError(`${label} must be a JSON array of strings`)
    }
    return (parsed as string[]).map((t) => t.trim()).filter(Boolean)
  }
  return trimmed
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

export function resolveRecipients(names: string[], all: Recipient[]): Recipient[] {
  if (names.includes('*')) return all
  return all.filter((r) => names.includes(r.id))
}
