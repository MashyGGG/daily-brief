import { describe, expect, it } from 'vitest'
import { ConfigError, parseConfig, applyRecipientOverride } from '../src/config/schema'
import { configYaml } from './helpers'

const EMPTY_ENV: NodeJS.ProcessEnv = {}

function expectIssue(fn: () => unknown, pathFragment: string) {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError)
    const issues = (err as ConfigError).issues.map((i) => `${i.path}: ${i.message}`).join('\n')
    expect(issues).toContain(pathFragment)
    return
  }
  throw new Error('expected the config to be rejected, but it loaded')
}

describe('config — the boundary table', () => {
  it('accepts a valid config and fills in the defaults', () => {
    const config = parseConfig(configYaml(), EMPTY_ENV)
    expect(config.schedules[0]!.sections).toEqual(['*'])
    expect(config.schedules[0]!.recipients).toEqual(['*'])
    expect(config.schedules[0]!.enabled).toBe(true)
    expect(config.archive.dir).toBe('archive')
    expect(config.archive.indexKeep).toBe(30)
    expect(config.recipients[0]!.format).toBe('markdown')
    expect(config.sections[0]!.minPerSource).toBe(0)
  })

  it('A4 — rejects an unknown channel, naming the recipient path', () => {
    expectIssue(
      () =>
        parseConfig(
          configYaml({
            recipients: `recipients:
  - id: me
    channel: carrier-pigeon
    secretRef: X
`,
          }),
          EMPTY_ENV,
        ),
      'recipients.0.channel',
    )
  })

  it('A4 — rejects a section referencing a source that does not exist', () => {
    expectIssue(
      () =>
        parseConfig(
          configYaml({
            sections: `sections:
  - id: tech
    title: 国际技术
    sources: [does-not-exist]
    limit: 8
`,
          }),
          EMPTY_ENV,
        ),
      'sections.0.sources.0',
    )
  })

  it('A4 — rejects a wecom recipient with no secretRef', () => {
    expectIssue(
      () =>
        parseConfig(
          configYaml({
            recipients: `recipients:
  - id: me-wecom
    channel: wecom
    sections: [tech]
`,
          }),
          EMPTY_ENV,
        ),
      'recipients.0.secretRef',
    )
  })

  it('A4 — rejects limit <= 0', () => {
    expectIssue(
      () =>
        parseConfig(
          configYaml({
            sections: `sections:
  - id: tech
    title: 国际技术
    sources: [hn-front]
    limit: 0
`,
          }),
          EMAIL_SAFE_ENV(),
        ),
      'sections.0.limit',
    )
  })

  it('A4 — rejects duplicate ids', () => {
    expectIssue(
      () =>
        parseConfig(
          configYaml({
            sections: `sections:
  - id: tech
    title: A
    sources: [hn-front]
    limit: 3
  - id: tech
    title: B
    sources: [verge]
    limit: 3
`,
          }),
          EMPTY_ENV,
        ),
      'sections.1.id',
    )
  })

  it('A4 — rejects a schedule pointing at an unknown recipient', () => {
    expectIssue(
      () =>
        parseConfig(
          configYaml({
            head: `timezone: Asia/Shanghai
schedules:
  - id: morning
    time: '08:00'
    recipients: [nobody]
`,
          }),
          EMPTY_ENV,
        ),
      'schedules.0.recipients.0',
    )
  })

  it('rejects a malformed time', () => {
    expectIssue(
      () =>
        parseConfig(
          configYaml({
            head: `timezone: Asia/Shanghai
schedules:
  - id: morning
    time: '8am'
`,
          }),
          EMPTY_ENV,
        ),
      'schedules.0.time',
    )
  })

  it('rejects a driver on a non-email channel', () => {
    expectIssue(
      () =>
        parseConfig(
          configYaml({
            recipients: `recipients:
  - id: me-wecom
    channel: wecom
    secretRef: WECOM_WEBHOOK_ME
    driver: smtp
`,
          }),
          EMPTY_ENV,
        ),
      'recipients.0.driver',
    )
  })

  it('requires a driver on an email recipient', () => {
    expectIssue(
      () =>
        parseConfig(
          configYaml({
            recipients: `recipients:
  - id: me-mail
    channel: email
`,
          }),
          EMPTY_ENV,
        ),
      'recipients.0.driver',
    )
  })

  it('lets an email recipient carry no mailbox at all — the secrets supply it', () => {
    const noTo = configYaml({
      recipients: `recipients:
  - id: me-mail
    channel: email
    driver: smtp
`,
    })
    // Not a config error: with EMAIL_TO unset the channel skips this recipient
    // (see the email channel's missingEnv), it does not sink the whole run.
    expect(parseConfig(noTo, EMAIL_SAFE_ENV()).recipients[0]!.to).toBeUndefined()
    expect(parseConfig(noTo, { ...EMAIL_SAFE_ENV(), EMAIL_TO: 'a@x.com' }).recipients).toHaveLength(
      1,
    )
  })

  it('rejects a malformed EMAIL_TO / EMAIL_CC secret at startup, by name', () => {
    const yaml = configYaml({
      recipients: `recipients:
  - id: me-mail
    channel: email
    driver: smtp
`,
    })
    expect(() => parseConfig(yaml, { ...EMAIL_SAFE_ENV(), EMAIL_TO: '["a@x.com"' })).toThrow(
      /EMAIL_TO/,
    )
    expect(() => parseConfig(yaml, { ...EMAIL_SAFE_ENV(), EMAIL_CC: '[1, 2]' })).toThrow(/EMAIL_CC/)
    // A well-formed JSON array is the documented shape for the CC secret.
    expect(() =>
      parseConfig(yaml, { ...EMAIL_SAFE_ENV(), EMAIL_CC: '["a@x.com","b@y.com"]' }),
    ).not.toThrow()
  })

  it('accepts a list of mailboxes on one recipient', () => {
    const config = parseConfig(
      configYaml({
        recipients: `recipients:
  - id: me-mail
    channel: email
    driver: smtp
    to: [a@x.com, b@y.com]
`,
      }),
      EMAIL_SAFE_ENV(),
    )
    expect(config.recipients[0]!.to).toEqual(['a@x.com', 'b@y.com'])
  })

  it('rejects an empty mailbox list rather than silently sending to nobody', () => {
    expectIssue(
      () =>
        parseConfig(
          configYaml({
            recipients: `recipients:
  - id: me-mail
    channel: email
    driver: smtp
    to: []
`,
          }),
          EMAIL_SAFE_ENV(),
        ),
      'recipients.0.to',
    )
  })
})

function EMAIL_SAFE_ENV(): NodeJS.ProcessEnv {
  return { EMAIL_FROM: 'me@example.com' }
}

const RESEND_RECIPIENTS = `recipients:
  - id: me-resend
    channel: email
    driver: resend
    to: me@example.com
`

describe('A15 — resend driver on the sandbox sender', () => {
  it('fails when EMAIL_FROM is the shared resend.dev sender', () => {
    expectIssue(
      () =>
        parseConfig(configYaml({ recipients: RESEND_RECIPIENTS }), {
          EMAIL_FROM: 'onboarding@resend.dev',
        }),
      'recipients.0.driver',
    )
  })

  it('fails when EMAIL_FROM is not set at all', () => {
    expectIssue(
      () => parseConfig(configYaml({ recipients: RESEND_RECIPIENTS }), {}),
      'recipients.0.driver',
    )
  })

  it('explains the sandbox limitation rather than just saying "invalid"', () => {
    try {
      parseConfig(configYaml({ recipients: RESEND_RECIPIENTS }), {
        EMAIL_FROM: 'onboarding@resend.dev',
      })
    } catch (err) {
      expect((err as ConfigError).message).toMatch(/sandbox/)
      expect((err as ConfigError).message).toMatch(/driver: smtp/)
      return
    }
    throw new Error('expected a ConfigError')
  })

  it('passes once EMAIL_FROM is a verified custom domain', () => {
    const config = parseConfig(configYaml({ recipients: RESEND_RECIPIENTS }), {
      EMAIL_FROM: 'brief@my-own-domain.dev',
    })
    expect(config.recipients[0]!.driver).toBe('resend')
  })

  it('ignores a disabled resend recipient', () => {
    const config = parseConfig(
      configYaml({
        recipients: `recipients:
  - id: me-wecom
    channel: wecom
    secretRef: WECOM_WEBHOOK_ME
  - id: me-resend
    channel: email
    driver: resend
    to: me@example.com
    enabled: false
`,
      }),
      { EMAIL_FROM: 'onboarding@resend.dev' },
    )
    expect(config.recipients).toHaveLength(2)
  })
})

describe('RECIPIENTS_OVERRIDE_JSON (§3.1 rule 3)', () => {
  const base = parseConfig(configYaml(), EMPTY_ENV)

  it('merges over an existing recipient by id', () => {
    const merged = applyRecipientOverride(
      base,
      JSON.stringify([{ id: 'me-wecom', sections: ['tech'] }]),
    )
    expect(merged.recipients[0]!.sections).toEqual(['tech'])
    expect(merged.recipients[0]!.secretRef).toBe('WECOM_WEBHOOK_ME')
  })

  it('appends a recipient that is not in the YAML', () => {
    const merged = applyRecipientOverride(
      base,
      JSON.stringify([
        { id: 'private', channel: 'email', driver: 'smtp', to: 'x@y.z', sections: ['*'] },
      ]),
    )
    expect(merged.recipients.map((r) => r.id)).toContain('private')
  })

  it('can still swap the mailbox list per-recipient, for a second email entry', () => {
    const withMail = parseConfig(
      configYaml({
        recipients: `recipients:
  - id: me-mail
    channel: email
    driver: smtp
    to: [a@x.com]
    format: html
`,
      }),
      EMAIL_SAFE_ENV(),
    )
    const merged = applyRecipientOverride(
      withMail,
      JSON.stringify([{ id: 'me-mail', to: ['a@x.com', 'b@y.com'] }]),
    )
    const mail = merged.recipients.find((r) => r.id === 'me-mail')!
    expect(mail.to).toEqual(['a@x.com', 'b@y.com'])
    // driver / format survive the shallow merge.
    expect(mail.driver).toBe('smtp')
    expect(mail.format).toBe('html')
    expect(merged.recipients).toHaveLength(1)
  })

  it('rejects malformed JSON instead of silently ignoring it', () => {
    expect(() => applyRecipientOverride(base, '{not json')).toThrow(ConfigError)
    expect(() => applyRecipientOverride(base, '{"id":"x"}')).toThrow(ConfigError)
  })

  it('leaves the config alone when unset or blank', () => {
    expect(applyRecipientOverride(base, undefined)).toBe(base)
    expect(applyRecipientOverride(base, '   ')).toBe(base)
  })

  it('re-validates the merged result — an override cannot smuggle in a bad reference', () => {
    expectIssue(
      () =>
        parseConfig(configYaml(), {
          RECIPIENTS_OVERRIDE_JSON: JSON.stringify([
            { id: 'me-wecom', sections: ['does-not-exist'] },
          ]),
        }),
      'recipients.0.sections.0',
    )
  })
})

describe('M0 — the knobs that replaced three hard-coded constants', () => {
  const withSections = (yaml: string) => parseConfig(configYaml({ sections: yaml }), EMPTY_ENV)

  it('defaults a section to enabled, so existing configs keep every section', () => {
    expect(parseConfig(configYaml(), EMPTY_ENV).sections.every((s) => s.enabled)).toBe(true)
  })

  it('accepts a retired section without touching its sources', () => {
    const config = withSections(`sections:
  - id: tech
    title: 国际技术
    sources: [hn-front]
    limit: 8
    enabled: false
  - id: news
    title: 国际要闻
    sources: [verge]
    limit: 5
`)
    expect(config.sections[0]!.enabled).toBe(false)
    expect(config.sections[0]!.sources).toEqual(['hn-front'])
  })

  it('defaults stripPatterns to empty, and render / dedupe to their measured values', () => {
    const config = parseConfig(configYaml(), EMPTY_ENV)
    expect(config.sources[0]!.stripPatterns).toEqual([])
    expect(config.render.excerptMaxChars).toBe(300)
    expect(config.dedupe.titleSimilarity).toBe(0.2)
  })

  it('rejects a stripPattern that is not a valid regex, at load rather than at 07:10', () => {
    expectIssue(
      () =>
        parseConfig(
          configYaml({
            sources: `sources:
  - name: hn-front
    type: hackernews
    weight: 1.2
    stripPatterns: ['[unclosed']
    params: { mode: front_page, minPoints: 100 }
  - name: verge
    type: rss
    params: { url: https://www.theverge.com/rss/index.xml }
`,
          }),
          EMPTY_ENV,
        ),
      'stripPatterns',
    )
  })

  it('rejects a similarity outside 0..1 rather than silently clamping it', () => {
    expectIssue(
      () => parseConfig(configYaml() + '\ndedupe:\n  titleSimilarity: 1.5\n', EMPTY_ENV),
      'titleSimilarity',
    )
  })
})
