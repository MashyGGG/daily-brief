import { describe, expect, it, vi } from 'vitest'
import { run, slotFor } from '../src/core/pipeline'
import { parseConfig } from '../src/config/schema'
import { memoryFs } from '../src/archive/fs'
import type { ArchiveRecord } from '../src/archive/read'
import type { ChannelContext, HttpFetch } from '../src/channels'
import { parseArgs } from '../src/cli'
import { NOW, configYaml } from './helpers'

/** A feed with two items, both inside the 24h window from NOW. */
function feed(prefix: string, count: number): string {
  const items = Array.from(
    { length: count },
    (_, i) =>
      `<item><title>${prefix} story ${i}</title><link>https://${prefix}.com/${i}</link>` +
      `<pubDate>${new Date(NOW.getTime() - 3600_000).toUTCString()}</pubDate></item>`,
  ).join('')
  return `<rss version="2.0"><channel>${items}</channel></rss>`
}

const CONFIG_YAML = configYaml({
  sources: `sources:
  - name: alpha
    type: rss
    weight: 1.2
    params: { url: https://alpha.com/rss }
  - name: beta
    type: rss
    weight: 1.0
    params: { url: https://beta.com/rss }
`,
  sections: `sections:
  - id: tech
    title: 国际技术
    sources: [alpha]
    limit: 5
  - id: news
    title: 国际要闻
    sources: [beta]
    limit: 5
`,
  recipients: `recipients:
  - id: me-wecom
    channel: wecom
    secretRef: WECOM_WEBHOOK_ME
    sections: [tech, news]
  - id: me-mail
    channel: email
    driver: smtp
    to: me@example.com
    sections: [tech]
    format: html
`,
})

const config = parseConfig(CONFIG_YAML, {})

function channelContext(over: Partial<ChannelContext> = {}): ChannelContext {
  return {
    env: {
      WECOM_WEBHOOK_ME: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key-value',
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '465',
      SMTP_USER: 'me@gmail.com',
      SMTP_PASS: 'app-password-1234',
      EMAIL_FROM: 'me@gmail.com',
    },
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      text: async () => '{"errcode":0}',
    })) as HttpFetch,
    sleep: async () => {},
    createMailer: () => ({ sendMail: async () => ({}) }),
    ...over,
  }
}

const okFetch = async (url: string) => ({
  ok: true,
  status: 200,
  text: async () => feed(url.includes('alpha') ? 'alpha' : 'beta', 3),
})

describe('pipeline', () => {
  it('builds sections, archives, then delivers', async () => {
    const fs = memoryFs()
    const ctx = channelContext()
    const result = await run({
      config,
      configHash: 'hash',
      now: NOW,
      env: ctx.env,
      dryRun: false,
      fetchImpl: okFetch,
      channelContext: ctx,
      fs,
    })

    expect(result.empty).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.brief.sections.map((s) => s.items.length)).toEqual([3, 3])
    expect(result.archived!.markdownPath).toBe('archive/2026/08/2026-08-20.md')
    expect(result.deliveries.every((d) => d.status === 'sent')).toBe(true)
  })

  it('§3.2 — archives BEFORE pushing, so a dead channel does not lose the content', async () => {
    const fs = memoryFs()
    const ctx = channelContext({
      fetchImpl: (async () => {
        throw new Error('qyapi unreachable')
      }) as unknown as HttpFetch,
    })
    const result = await run({
      config,
      configHash: 'hash',
      now: NOW,
      env: ctx.env,
      dryRun: false,
      fetchImpl: okFetch,
      channelContext: ctx,
      fs,
    })

    // A6: the archive is complete, mail still went out, wecom failed, the job fails.
    expect(fs.files.has('archive/2026/08/2026-08-20.json')).toBe(true)
    expect(result.deliveries.find((d) => d.recipient === 'me-mail')!.status).toBe('sent')
    expect(result.deliveries.find((d) => d.recipient === 'me-wecom')!.status).toBe('failed')
    expect(result.exitCode).toBe(1)
  })

  it('§3.1 rule 1 — a missing secret skips that recipient only', async () => {
    const ctx = channelContext()
    delete ctx.env.WECOM_WEBHOOK_ME
    const result = await run({
      config,
      configHash: 'hash',
      now: NOW,
      env: ctx.env,
      dryRun: false,
      fetchImpl: okFetch,
      channelContext: ctx,
      fs: memoryFs(),
    })
    const wecom = result.deliveries.find((d) => d.recipient === 'me-wecom')!
    expect(wecom.status).toBe('skipped')
    expect(wecom.detail).toContain('WECOM_WEBHOOK_ME')
    expect(result.exitCode).toBe(0)
  })

  it('A5 — one dead source leaves a warning and the rest of the brief intact', async () => {
    const result = await run({
      config,
      configHash: 'hash',
      now: NOW,
      env: {},
      dryRun: true,
      fetchImpl: async (url) => {
        if (url.includes('beta')) throw new Error('HTTP 500')
        return okFetch(url)
      },
      channelContext: channelContext(),
      fs: memoryFs(),
    })
    expect(result.brief.sections.find((s) => s.id === 'tech')!.items).toHaveLength(3)
    expect(result.brief.sections.find((s) => s.id === 'news')!.items).toHaveLength(0)
    expect(result.brief.warnings[0]).toContain('beta')
    expect(result.exitCode).toBe(0)
  })

  it('A7 — the second run drops everything the first one already published', async () => {
    const fs = memoryFs()
    const ctx = channelContext()
    const args = {
      config,
      configHash: 'hash',
      env: ctx.env,
      dryRun: false,
      fetchImpl: okFetch,
      channelContext: ctx,
      fs,
    }
    const first = await run({ ...args, now: NOW })
    expect(first.brief.sections[0]!.items).toHaveLength(3)

    const tomorrow = new Date(NOW.getTime() + 24 * 3600_000)
    const second = await run({
      ...args,
      now: tomorrow,
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        // Same stories, restamped as fresh — they must still be recognised.
        text: async () =>
          feed(url.includes('alpha') ? 'alpha' : 'beta', 3).replace(
            /<pubDate>[^<]+<\/pubDate>/g,
            `<pubDate>${new Date(tomorrow.getTime() - 3600_000).toUTCString()}</pubDate>`,
          ),
      }),
    })
    expect(second.empty).toBe(true)
    expect(second.dedupeDropped.alreadySeen).toBe(6)
  })

  it('§3.2 — nothing to say means nothing is sent and nothing is archived', async () => {
    const fs = memoryFs()
    const result = await run({
      config,
      configHash: 'hash',
      now: NOW,
      env: {},
      dryRun: false,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<rss><channel/></rss>' }),
      channelContext: channelContext(),
      fs,
    })
    expect(result.empty).toBe(true)
    expect(result.deliveries).toEqual([])
    expect(result.archived).toBeNull()
    expect(fs.files.size).toBe(0)
  })

  it('A1 — dry-run writes nothing and sends nothing to a real channel', async () => {
    const fs = memoryFs()
    const sent = vi.fn()
    const result = await run({
      config,
      configHash: 'hash',
      now: NOW,
      env: {},
      dryRun: true,
      fetchImpl: okFetch,
      channelContext: channelContext({ fetchImpl: sent as unknown as HttpFetch, log: () => {} }),
      fs,
    })
    expect(fs.files.size).toBe(0)
    expect(sent).not.toHaveBeenCalled()
    expect(result.deliveries.every((d) => d.status === 'sent')).toBe(true)
  })

  it('A3 — --sections narrows what gets built', async () => {
    const result = await run({
      config,
      configHash: 'hash',
      now: NOW,
      env: {},
      dryRun: true,
      sections: ['tech'],
      fetchImpl: okFetch,
      channelContext: channelContext({ log: () => {} }),
      fs: memoryFs(),
    })
    expect(result.brief.sections.map((s) => s.id)).toEqual(['tech'])
  })

  it('an item is placed in exactly one section', async () => {
    const shared = parseConfig(
      configYaml({
        sources: `sources:
  - name: alpha
    type: rss
    params: { url: https://alpha.com/rss }
`,
        sections: `sections:
  - id: tech
    title: A
    sources: [alpha]
    limit: 2
  - id: news
    title: B
    sources: [alpha]
    limit: 2
`,
        recipients: `recipients:
  - id: me
    channel: wecom
    secretRef: W
`,
      }),
      {},
    )
    const result = await run({
      config: shared,
      configHash: 'h',
      now: NOW,
      env: {},
      dryRun: true,
      fetchImpl: okFetch,
      channelContext: channelContext({ log: () => {} }),
      fs: memoryFs(),
    })
    const ids = result.brief.sections.flatMap((s) => s.items.map((i) => i.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('A14 — --from-archive re-sends without fetching anything', async () => {
    const record: ArchiveRecord = {
      date: '2026-08-19',
      slot: null,
      scheduleId: 'morning',
      generatedAt: '2026-08-19T00:30:00.000Z',
      configHash: 'hash',
      timezone: 'Asia/Shanghai',
      lookbackHours: 24,
      itemCount: 1,
      items: [
        {
          id: 'x',
          title: 'Archived story',
          url: 'https://a.com/x',
          source: 'alpha',
          section: 'tech',
          publishedAt: '2026-08-19T00:00:00.000Z',
          rankScore: 0.9,
        },
      ],
      warnings: [],
    }
    const fs = memoryFs({ 'archive/2026/08/2026-08-19.json': JSON.stringify(record) })
    const fetchImpl = vi.fn()
    const result = await run({
      config,
      configHash: 'hash',
      now: NOW,
      env: {},
      dryRun: true,
      fromArchive: '2026-08-19',
      fetchImpl: fetchImpl as never,
      channelContext: channelContext({ log: () => {} }),
      fs,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.brief.date).toBe('2026-08-19')
    expect(result.brief.sections.find((s) => s.id === 'tech')!.items[0]!.title).toBe(
      'Archived story',
    )
  })

  it('A14 — a missing archived issue is an error, not an empty brief', async () => {
    await expect(
      run({
        config,
        configHash: 'hash',
        now: NOW,
        env: {},
        dryRun: true,
        fromArchive: '2020-01-01',
        fetchImpl: okFetch,
        channelContext: channelContext(),
        fs: memoryFs(),
      }),
    ).rejects.toThrow(/No archived issue/)
  })

  it('A19 — an unknown --cron aborts the run', async () => {
    await expect(
      run({
        config,
        configHash: 'hash',
        now: NOW,
        env: {},
        dryRun: true,
        cron: '5 5 * * *',
        fetchImpl: okFetch,
        channelContext: channelContext(),
        fs: memoryFs(),
      }),
    ).rejects.toThrow(/No enabled schedule/)
  })

  it('requires an explicit schedule when several are enabled', async () => {
    const two = parseConfig(
      configYaml({
        head: `timezone: Asia/Shanghai
schedules:
  - id: morning
    time: '08:00'
  - id: evening
    time: '20:00'
`,
      }),
      {},
    )
    await expect(
      run({
        config: two,
        configHash: 'h',
        now: NOW,
        env: {},
        dryRun: true,
        fetchImpl: okFetch,
        channelContext: channelContext(),
        fs: memoryFs(),
      }),
    ).rejects.toThrow(/--schedule/)
  })

  it('A18 — the archive filename carries a slot suffix only with multiple schedules', () => {
    const one = parseConfig(configYaml(), {})
    expect(slotFor(one, one.schedules[0]!)).toBeNull()

    const two = parseConfig(
      configYaml({
        head: `timezone: Asia/Shanghai
schedules:
  - id: morning
    time: '08:00'
  - id: evening
    time: '20:00'
`,
      }),
      {},
    )
    expect(slotFor(two, two.schedules[1]!)).toBe('evening')
  })

  it('A16 — a channel failure carrying a webhook URL is redacted before archiving', async () => {
    const fs = memoryFs()
    const ctx = channelContext({
      fetchImpl: (async (url: string) => {
        throw new Error(`connect ECONNREFUSED for ${url}`)
      }) as unknown as HttpFetch,
    })
    await run({
      config,
      configHash: 'hash',
      now: NOW,
      env: ctx.env,
      dryRun: false,
      fetchImpl: async (url) => {
        if (url.includes('beta')) throw new Error(`fetch ${ctx.env.WECOM_WEBHOOK_ME} failed`)
        return okFetch(url)
      },
      channelContext: ctx,
      fs,
    })
    const archived = fs.files.get('archive/2026/08/2026-08-20.json')!
    expect(archived).not.toContain('secret-key-value')
    expect(archived).toContain('REDACTED')
  })
})

describe('cli argument parsing', () => {
  it('parses the full flag set', () => {
    const args = parseArgs([
      '--schedule',
      'evening',
      '--sections',
      'tech, news',
      '--recipients',
      'me-wecom',
      '--from-archive',
      '2026-08-20',
      '--dry-run',
      '--no-commit',
    ])
    expect(args).toMatchObject({
      schedule: 'evening',
      sections: ['tech', 'news'],
      recipients: ['me-wecom'],
      fromArchive: '2026-08-20',
      dryRun: true,
      noCommit: true,
    })
  })

  it('treats an empty --cron as absent, the way a manual dispatch passes it', () => {
    expect(parseArgs(['--cron', '']).cron).toBe('')
  })

  it('rejects an unknown option instead of ignoring it', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/)
  })

  it('rejects a malformed --from-archive date', () => {
    expect(() => parseArgs(['--from-archive', 'yesterday'])).toThrow(/YYYY-MM-DD/)
  })

  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['--schedule'])).toThrow(/needs a value/)
  })
})
