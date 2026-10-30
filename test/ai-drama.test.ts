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
import { assessDramaItem, inspectDramaCandidates } from '../src/learning/quality'
import { dramaSection, isDramaBusiness } from '../src/learning/classify'
import { itemId } from '../src/core/normalize'
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
  it('classifies production tutorials ahead of their discovery feed and rejects generic AI business stories', () => {
    expect(dramaSection(item({ source: 'drama-cn-news', title: 'AI短剧分镜实战教程' }))).toBe(
      'drama-tutorials',
    )
    expect(
      dramaSection(
        item({ source: 'drama-cn-news', title: '南威软件收警示函，三季报增亏2.21亿元' }),
      ),
    ).toBeNull()
    expect(
      dramaSection(
        item({
          source: 'drama-en-models',
          title: 'Gaming’s Business Model Is Broken. AI Can Fix It',
        }),
      ),
    ).toBeNull()
    expect(
      dramaSection(
        item({
          source: 'drama-en-news',
          title: 'Akuna launches free AI filmmaking programme for creators',
        }),
      ),
    ).toBe('drama-news')
    expect(dramaSection(item({ source: 'drama-comfyui', title: 'v0.43.2' }))).toBe('drama-tools')
    expect(
      dramaSection(
        item({ source: 'drama-cn-news', title: 'AI短剧三国杀：腾讯快手字节加码，未来会怎么走？' }),
      ),
    ).toBe('drama-news')
    expect(
      dramaSection(
        item({
          source: 'drama-en-models',
          title: 'PixVerse Launches Innovative Image-to-Video Workflow',
        }),
      ),
    ).toBe('drama-tools')
    expect(
      dramaSection(
        item({
          source: 'drama-comfy-tutorials',
          title: 'Comfy Agent: The First Agent for Craft',
          excerpt: 'Build a ComfyUI workflow.',
        }),
      ),
    ).toBe('drama-tools')
    expect(
      dramaSection(
        item({
          source: 'drama-comfy-tutorials',
          title: 'How I Generated Live Video with MiniMax H3 on a Single GPU',
          excerpt: 'A ComfyUI workflow',
        }),
      ),
    ).toBe('drama-tutorials')
  })

  it('uses a 30-day tutorial window, keeps the original source, and remembers older tutorial deliveries', async () => {
    const names = ['drama-cn-news', 'drama-cn-tutorial', 'drama-comfy-tutorials', 'drama-ltx']
    const cfg = parseConfig(
      configYaml({
        head: `timezone: Asia/Shanghai\npublish: {include: [drama-news]}\nschedules: [{id: ai-drama, time: '08:10', lookbackHours: 48, dedupeGroup: ai-drama, sendEmpty: true}]\n`,
        sources:
          'sources:\n' +
          names
            .map(
              (name) =>
                `  - name: ${name}\n    type: rss\n    params: {url: 'https://example.com/${name}'}\n`,
            )
            .join(''),
        sections: `sections:\n  - id: drama-news\n    title: 资讯\n    sources: [${names}]\n    limit: 10\n  - id: drama-tutorials\n    title: 教程\n    sources: [${names}]\n    limit: 6\n    lookbackHours: 720\n  - id: drama-tools\n    title: 技术\n    sources: [${names}]\n    limit: 10\n`,
        recipients: 'recipients: [{id: mail, channel: email, driver: smtp}]\n',
      }),
      {},
    )
    const entry = (title: string, url: string, days: number) =>
      `<item><title>${title}</title><link>${url}</link><description>导入参考图素材，设置提示词参数，生成分镜。</description><pubDate>${new Date(NOW.getTime() - days * 86400000).toUTCString()}</pubDate></item>`
    const stories: Record<string, string> = {
      'drama-cn-news':
        entry('AI短剧分镜实战教程', 'https://example.com/tutorial', 10) +
        entry('AI漫剧行业案例', 'https://example.com/news', 1) +
        entry('AI短剧财报增长', 'https://example.com/finance-a', 1) +
        entry('AI短剧融资扩大', 'https://example.com/finance-b', 1) +
        entry('AI短剧营收增长', 'https://example.com/finance-c', 1) +
        entry('AI短剧旧消息', 'https://example.com/old-news', 10),
      'drama-cn-tutorial': entry('AI短剧分镜实战教程', 'https://example.com/tutorial', 10),
      'drama-comfy-tutorials':
        entry('AI短剧分镜实战教程', 'https://example.com/tutorial', 10) +
        entry('ComfyUI video workflow guide', 'https://example.com/already-sent', 25),
      'drama-ltx': entry('v2.1.0', 'https://example.com/release', 1),
    }
    const fs = memoryFs({
      'archive/2026/07/2026-07-31.ai-drama.json': JSON.stringify({
        dedupeGroup: 'ai-drama',
        items: [
          item({
            id: itemId('https://example.com/already-sent'),
            title: 'ComfyUI video workflow guide',
          }),
        ],
      }),
    })
    const result = await run({
      config: cfg,
      configHash: 'test',
      now: NOW,
      env: {},
      dryRun: false,
      fs,
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        text: async () => `<rss><channel>${stories[url.split('/').pop()!]}</channel></rss>`,
      }),
      channelContext: { env: {}, fetchImpl: vi.fn(), sleep: async () => {} },
    })
    expect(result.brief.sections.map((s) => s.id)).toEqual([
      'drama-news',
      'drama-tutorials',
      'drama-tools',
    ])
    expect(result.brief.sections[0]!.items.map((i) => i.url)).toContain('https://example.com/news')
    expect(result.brief.sections[0]!.items.filter((i) => i.url.includes('finance-'))).toHaveLength(
      2,
    )
    expect(result.brief.sections[0]!.items).toHaveLength(3)
    expect(result.brief.warnings.join()).toContain('不以低质量内容补足')
    expect(result.brief.sections[1]!.items).toHaveLength(1)
    expect(result.brief.sections[1]!.items[0]!.source).toBe('drama-comfy-tutorials')
    expect(result.brief.sections[2]!.items[0]!.url).toBe('https://example.com/release')
    expect(result.dedupeDropped.alreadySeen).toBe(1)
  })
  it('keeps business interviews out of tutorials and financial forecasts out of technology', () => {
    for (const title of [
      '内容厂商如何守住AI短剧牌桌？对话内容厂商解密商业化爆款逻辑',
      '【明日主题前瞻】字节跳动旗下即梦短剧工作室上线，AI短剧行业规模有望持续扩容',
    ])
      expect(dramaSection(item({ title, source: 'drama-cn-models' }))).toBe('drama-news')
    expect(isDramaBusiness(item({ title: 'AI短剧出海，如何守住版权护城河' }))).toBe(false)
    const evidence = {
      text: '导入参考图，设置提示词参数，运行工作流并导出视频。',
      kind: 'excerpt' as const,
    }
    const tutorial = assessDramaItem(item({ title: 'AI短剧制作教程' }), evidence, NOW)!
    expect(tutorial.editorial?.difficulty).toBe('进阶')
    expect(tutorial.editorial?.evidence).toBe('excerpt')
    expect(
      assessDramaItem(
        item({ title: 'AI短剧制作教程' }),
        { ...evidence, text: '颠覆行业，简单上手。' },
        NOW,
      ),
    ).toBeNull()
    expect(
      assessDramaItem(
        item({ title: 'AI Video Model Comparison' }),
        { ...evidence, text: 'Pick the best video tool!' },
        NOW,
      ),
    ).toBeNull()
    expect(
      assessDramaItem(
        item({ title: 'AI Video Model Comparison' }),
        { ...evidence, text: 'Test setup: measured latency and VRAM on the same GPU.' },
        NOW,
      )?.editorial?.kind,
    ).toBe('review')
    expect(
      assessDramaItem(
        item({ title: 'AI Video: Runway comeback in 2024?' }),
        evidence,
        new Date('2026-10-30'),
      ),
    ).toBeNull()
    expect(productionLines(tutorial).join()).toContain('仅来源摘要')
    const brief = {
      date: '2026-10-30',
      title: '学习日报',
      scheduleId: 'ai-drama',
      slot: 'ai-drama',
      timezone: 'Asia/Shanghai',
      generatedAt: NOW.toISOString(),
      lookbackHours: 48,
      sections: [{ id: 'drama-tutorials', title: '教程', items: [tutorial] }],
      warnings: [],
    }
    for (const rendered of [renderHtml(brief), renderText(brief), renderArchiveMarkdown(brief)]) {
      expect(rendered).toContain('建议行动')
      expect(rendered).toContain('仅来源摘要')
    }
  })

  it('rejects tutorial resource advertising, consumption gossip and unsubstantiated tested lists', () => {
    for (const title of [
      '最新宝藏资源：小白AI漫剧全套教程',
      '75岁大爷熬夜刷AI短剧，医生提醒',
      '胡锡进痛批AI短剧是电子饲料',
    ]) {
      expect(dramaSection(item({ title }))).toBeNull()
    }
    const list = item({ title: 'Best AI Video Generators 2026: Our Tested Top Picks' })
    expect(assessDramaItem(list, { kind: 'excerpt', text: list.title }, NOW)).toBeNull()
  })

  it('checks article evidence without an LLM and falls back honestly when fetching fails', async () => {
    const entries = [
      item({
        id: 'good',
        title: 'ComfyUI 制作教程',
        section: 'drama-tutorials',
        url: 'https://example.com/good',
        excerpt: '标题摘要',
      }),
      item({
        id: 'bad',
        title: 'AI短剧教程',
        section: 'drama-tutorials',
        url: 'https://example.com/bad',
        excerpt: '轻松成功',
      }),
    ]
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/bad')) throw new Error('offline')
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () =>
          `<article><p>${'导入参考图素材，设置提示词参数并运行工作流。'.repeat(15)}</p></article>`,
      }
    })
    const result = await inspectDramaCandidates(entries, {
      now: NOW,
      fetchImpl,
      config: llmSchema.parse({}).extract,
      maxChars: 6000,
    })
    expect(result.items.map((i) => i.id)).toEqual(['good'])
    expect(result.items[0]!.editorial?.evidence).toBe('fulltext')
    expect(result.rejected).toBe(1)
    expect(result.evidence.get('bad')?.kind).toBe('excerpt')
    const planningFetch = vi.fn()
    await inspectDramaCandidates(entries, {
      now: NOW,
      fetchImpl: planningFetch,
      config: llmSchema.parse({}).extract,
      maxChars: 6000,
      planOnly: true,
    })
    expect(planningFetch).not.toHaveBeenCalled()
  })

  it('uses explicit AI review booleans, preserves rule decisions on missing reviews, and reuses extracted evidence', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: '制作教程',
                  takeaways: [],
                  editorialReview: { relevant: true, actionable: false },
                }),
              },
            },
          ],
        }),
    }))
    const extractFetchImpl = vi.fn()
    const entry = item({ id: 'reviewed', title: 'AI短剧教程' })
    const result = await enrichSections(
      [{ id: 'drama-tutorials', title: '教程', items: [entry] }],
      llmSchema.parse({
        enabled: true,
        defaults: { summarize: true, fetchFullText: true },
        digest: { enabled: false },
      }),
      {
        env: { LLM_API_KEY: 'fake' },
        fetchImpl,
        extractFetchImpl,
        learningStage: '入门',
        dramaEvidence: new Map([[entry.id, { kind: 'fulltext', text: '导入素材并设置参数' }]]),
      },
    )
    expect(result.sections[0]!.items).toHaveLength(0)
    expect(result.warnings.join()).toContain('AI 辅助排除 1 条')
    expect(result.stats.fullText).toBe(1)
    expect(extractFetchImpl).not.toHaveBeenCalled()
  })

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
