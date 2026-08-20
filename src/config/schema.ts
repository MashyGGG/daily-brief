import { z } from 'zod'
import { parse as parseYaml } from 'yaml'

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
  excerpt?: string
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

export const sourceSchema = z.discriminatedUnion('type', [
  z.object({
    name: ID,
    type: z.literal('rss'),
    weight: z.number().positive().default(1),
    params: z.object({
      url: z.string().url(),
      limit: z.number().int().positive().max(200).default(50),
    }),
  }),
  z.object({
    name: ID,
    type: z.literal('hackernews'),
    weight: z.number().positive().default(1),
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

export const recipientSchema = z.object({
  id: ID,
  channel: z.enum(['wecom', 'email', 'serverchan', 'pushplus', 'wxpusher', 'telegram', 'stdout']),
  driver: z.enum(['smtp', 'resend']).optional(),
  secretRef: z.string().min(1).optional(),
  to: z.string().optional(),
  sections: WILDCARD_LIST.default(['*']),
  format: z.enum(['markdown', 'html', 'text']).default('markdown'),
  enabled: z.boolean().default(true),
})

export type Schedule = z.infer<typeof scheduleSchema>
export type Source = z.infer<typeof sourceSchema>
export type Section = z.infer<typeof sectionSchema>
export type ArchiveConfig = z.infer<typeof archiveSchema>
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
        if (!r.to) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['recipients', i, 'to'],
            message: `recipient "${r.id}" (channel email) requires "to"`,
          })
        }
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
  assertResendSender(revalidated.data, env)
  return revalidated.data
}

export function resolveSections(names: string[], all: Section[]): Section[] {
  if (names.includes('*')) return all
  return all.filter((s) => names.includes(s.id))
}

export function resolveRecipients(names: string[], all: Recipient[]): Recipient[] {
  if (names.includes('*')) return all
  return all.filter((r) => names.includes(r.id))
}
