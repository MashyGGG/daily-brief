import { describe, expect, it, vi } from 'vitest'
import { llmSchema, parseConfig } from '../src/config/schema'
import { memoryFs } from '../src/archive/fs'
import { readRecentItems } from '../src/archive/read'
import { run } from '../src/core/pipeline'
import { renderHtml } from '../src/render/html'
import { renderText } from '../src/render/text'
import { aiDramaReminder, rankForLearning } from '../src/learning/ai-drama'
import { productionNotes, productionLines } from '../src/learning/content'
import { enrichSections } from '../src/enrich'
import { readDeliveryState } from '../src/archive/delivery'
import { renderArchiveMarkdown } from '../src/render/markdown'
import { configYaml, item, NOW } from './helpers'
import type { FetchLike } from '../src/sources'

const config = () =>
  parseConfig(
    configYaml({
      head: `timezone: Asia/Shanghai
aiDrama: { stage: observe }
publish: { include: [drama] }
schedules:
  - id: ai-drama
    time: '08:10'
    dedupeGroup: ai-drama
    sendEmpty: true
`,
      sources: `sources:
  - name: alpha
    type: rss
    params: { url: https://example.com/feed }
`,
      sections: `sections:
  - id: drama
    title: 教程
    sources: [alpha]
    limit: 6
`,
      recipients: `recipients:
  - id: mail
    channel: email
    driver: smtp
    format: html
`,
    }),
    {},
  )

describe('AI drama learning edition', () => {
  it('prioritizes the current production problem while retaining unrelated developments', () => {
    const input = [
      item({ id: 'a', title: '新手分镜入门', rankScore: 0.5 }),
      item({ id: 'b', title: '开源部署显存优化', rankScore: 0.5 }),
    ]
    const observe = rankForLearning(input, 'observe')
    const engineer = rankForLearning(input, 'engineer')
    expect(observe[0]!.rankScore).toBeGreaterThan(observe[1]!.rankScore)
    expect(engineer[1]!.rankScore).toBeGreaterThan(engineer[0]!.rankScore)
    expect(input[0]!.rankScore).toBe(0.5)
    const cfg = config()
    const first = aiDramaReminder(cfg, 'example/repo', '2026-10-30')
    const next = aiDramaReminder(cfg, 'example/repo', '2026-10-31')
    expect(first.stage).toBe(next.stage)
    expect(first.lesson?.title).not.toBe(next.lesson?.title)
    expect(first.guideUrl).toContain('example/repo')
  })

  it('resumes failed recipients from the archive and never resends confirmed automatic deliveries', async () => {
    const cfg = config()
    cfg.recipients.push({ ...cfg.recipients[0]!, id: 'second' })
    const fs = memoryFs()
    const env = {
      SMTP_HOST: 'smtp.test',
      SMTP_PORT: '465',
      SMTP_USER: 'private@test.com',
      SMTP_PASS: 'private-password',
      EMAIL_FROM: 'private@test.com',
      EMAIL_TO: 'reader@test.com',
    }
    const sendMail = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('network private-password'))
      .mockResolvedValue({})
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<rss><channel></channel></rss>',
    }))
    const options = {
      config: cfg,
      configHash: 'test',
      now: NOW,
      env,
      fs,
      dryRun: false,
      resumeDelivery: true,
      fetchImpl,
      channelContext: {
        env,
        fetchImpl: vi.fn(),
        sleep: async () => {},
        createMailer: () => ({ sendMail }),
      },
    }
    const first = await run(options)
    expect(first.exitCode).toBe(1)
    expect(sendMail).toHaveBeenCalledTimes(2)
    const savedLesson = first.brief.learningReminder?.lesson
    cfg.aiDrama!.stage = 'engineer'
    const fetchCount = fetchImpl.mock.calls.length
    const second = await run(options)
    expect(second.exitCode).toBe(0)
    expect(second.archived).toBeNull()
    expect(second.deliveryStateChanged).toBe(true)
    expect(sendMail).toHaveBeenCalledTimes(3)
    expect(fetchImpl).toHaveBeenCalledTimes(fetchCount)
    expect(second.brief.learningReminder?.lesson).toEqual(savedLesson)
    expect(renderArchiveMarkdown(second.brief)).toContain('常青教材')
    const third = await run(options)
    expect(third.deliveries.every((d) => d.status === 'skipped')).toBe(true)
    expect(third.deliveryStateChanged).toBe(false)
    expect(sendMail).toHaveBeenCalledTimes(3)
    const ledger = fs.readFile('archive/delivery/2026-08-20.ai-drama.json')!
    expect(ledger).not.toContain('private-password')
    expect(ledger).not.toContain('@test.com')
  })

  it('does not guess delivery success from corrupt state', () => {
    const fs = memoryFs({ 'bad.json': '{bad' })
    expect(() => readDeliveryState(fs, 'bad.json', '2026-10-30', 'ai-drama')).toThrow('unreadable')
    expect(
      readDeliveryState(memoryFs(), 'missing.json', '2026-10-30', 'ai-drama').recipients,
    ).toEqual({})
  })

  it('extracts bounded production notes without trusting generated links or verification claims', () => {
    const notes = productionNotes(
      JSON.stringify({
        productionNotes: {
          suitableFor: '<b>分镜</b>',
          steps: ['下载 https://evil.test/a', '下载 https://evil.test/a', 3, '测试'],
          requirements: '参考图',
          evidence: 'fulltext',
          verified: true,
        },
      }),
      'excerpt',
    )!
    expect(notes.evidence).toBe('excerpt')
    expect(notes.steps).toHaveLength(2)
    expect(JSON.stringify(notes)).not.toContain('evil.test')
    expect(productionLines({ ...item(), productionNotes: notes }).join()).toContain(
      '未经本项目运行验证',
    )
    expect(productionNotes('{"productionNotes":{"steps":[]}}', 'excerpt')).toBeUndefined()
  })

  it('stores structured notes through the actual model adapter and renders HTML and text consistently', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: '用参考图制作镜头',
                  takeaways: [],
                  productionNotes: {
                    suitableFor: '角色一致性',
                    steps: ['固定参考图', '生成镜头'],
                    requirements: '原图',
                  },
                }),
              },
            },
          ],
        }),
    }))
    const result = await enrichSections(
      [{ id: 'tech', title: '技术', items: [item({ excerpt: 'original' })] }],
      llmSchema.parse({ enabled: true, defaults: { summarize: true }, digest: { enabled: false } }),
      { env: { LLM_API_KEY: 'fake' }, fetchImpl, learningStage: '单镜头练习' },
    )
    const entry = result.sections[0]!.items[0]!
    expect(entry.productionNotes?.steps).toEqual(['固定参考图', '生成镜头'])
    expect(entry.productionNotes?.evidence).toBe('excerpt')
    expect(entry.summaryMeta?.promptVersion).toContain('ai-drama')
    expect(fetchImpl.mock.calls[0]).toBeDefined()
    const brief = {
      date: '2026-10-30',
      title: '学习日报',
      scheduleId: 'ai-drama',
      slot: 'ai-drama',
      timezone: 'Asia/Shanghai',
      generatedAt: NOW.toISOString(),
      lookbackHours: 48,
      sections: result.sections,
      warnings: [],
    }
    expect(renderHtml(brief)).toContain('步骤 1：固定参考图')
    expect(renderText(brief)).toContain('步骤 1：固定参考图')
    expect(renderArchiveMarkdown(brief)).toContain('角色一致性')
    expect(entry.excerpt).toBe('original')
  })
  it('isolates both sides of history while still reading legacy archives', () => {
    const fs = memoryFs({
      'archive/2026/08/2026-08-20.morning.json': JSON.stringify({
        items: [item({ id: 'legacy' })],
      }),
      'archive/2026/08/2026-08-20.ai-drama.json': JSON.stringify({
        dedupeGroup: 'ai-drama',
        items: [item({ id: 'drama' })],
      }),
    })
    expect(
      readRecentItems('archive', '2026-08-20', 1, fs, 'default').items.map((i) => i.id),
    ).toEqual(['legacy'])
    expect(
      readRecentItems('archive', '2026-08-20', 1, fs, 'ai-drama').items.map((i) => i.id),
    ).toEqual(['drama'])
  })

  it('sends empty editions with the roadmap last and preserves the stage on replay', async () => {
    const cfg = config()
    const fs = memoryFs()
    const sendMail = vi.fn(async () => ({}))
    const env = {
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_USER: 'sender@example.com',
      EMAIL_FROM: 'sender@example.com',
      SMTP_PASS: 'fake',
      EMAIL_TO: 'reader@example.com',
    }
    const options = {
      config: cfg,
      configHash: 'test',
      now: NOW,
      env,
      dryRun: false,
      fs,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        text: async () => '<rss><channel></channel></rss>',
      })) as FetchLike,
      channelContext: {
        env,
        fetchImpl: vi.fn(),
        sleep: async () => {},
        createMailer: () => ({ sendMail }),
      },
    }
    const result = await run(options)
    expect(result.deliveries[0]?.status).toBe('sent')
    expect(result.archived).not.toBeNull()
    expect(result.brief.warnings.join()).toContain('暂无符合条件')
    expect(renderHtml(result.brief).indexOf('学习与制作步骤提醒')).toBeGreaterThan(
      renderHtml(result.brief).indexOf('自动生成'),
    )
    expect(renderText(result.brief).trim().endsWith('/docs/ai-drama/PLAYBOOK.md')).toBe(true)
    expect(result.brief.learningReminder?.steps).toHaveLength(5)
    cfg.aiDrama!.stage = 'publish'
    const replayFetch = vi.fn()
    const replay = await run({ ...options, fromArchive: '2026-08-20', fetchImpl: replayFetch })
    expect(replay.brief.learningReminder?.stage).toBe('了解与选方向')
    expect(replay.archived).toBeNull()
    expect(replayFetch).not.toHaveBeenCalled()
    const failed = await run({
      ...options,
      fetchImpl: async () => {
        throw new Error('offline')
      },
      sleep: async () => {},
    })
    expect(failed.brief.warnings.join()).toContain('采集覆盖不足')
    expect(failed.deliveries[0]?.status).toBe('sent')
  })

  it('changes reminders only with an explicit stage selection and rejects invalid stages', () => {
    const cfg = config()
    cfg.aiDrama!.stage = 'engineer'
    expect(aiDramaReminder(cfg, undefined).stage).toBe('技术复现与开发')
    expect(aiDramaReminder(cfg, 'bad/url/extra').guideUrl).toContain('MashyGGG/daily-brief')
    expect(() =>
      parseConfig(
        configYaml({
          head: 'aiDrama: {stage: invalid}\nschedules: [{id: morning, time: "08:00"}]\n',
        }),
        {},
      ),
    ).toThrow()
  })
})
