import { describe, expect, it } from 'vitest'
import { llmSchema, type LlmConfig } from '../src/config/schema'
import type { BriefSection } from '../src/core/brief'
import {
  estimateTokens,
  passesWhen,
  planEnrichment,
  resolvePolicy,
  titleLanguage,
} from '../src/enrich/policy'
import { item } from './helpers'

function llm(overrides: Record<string, unknown> = {}): LlmConfig {
  return llmSchema.parse({ enabled: true, ...overrides })
}

const section = (id: string, ...items: ReturnType<typeof item>[]): BriefSection => ({
  id,
  title: id,
  items,
})

describe('resolvePolicy — source > section > defaults', () => {
  it('falls all the way back to defaults when nothing is declared', () => {
    expect(resolvePolicy(llm(), 'hn-front', 'tech')).toEqual({
      summarize: false,
      style: 'bullet',
      language: 'zh-CN',
      maxChars: 180,
      fetchFullText: false,
    })
  })

  it('a section opt-in reaches every source in it', () => {
    const cfg = llm({ sections: { tech: { summarize: true, maxChars: 220 } } })
    expect(resolvePolicy(cfg, 'hn-front', 'tech')).toMatchObject({ summarize: true, maxChars: 220 })
    expect(resolvePolicy(cfg, 'hn-front', 'news')).toMatchObject({ summarize: false })
  })

  it('a source overrides its section', () => {
    const cfg = llm({
      sections: { tech: { summarize: true, style: 'bullet' } },
      sources: { 'gh-trending-ts': { summarize: false } },
    })
    expect(resolvePolicy(cfg, 'gh-trending-ts', 'tech').summarize).toBe(false)
    expect(resolvePolicy(cfg, 'lobsters', 'tech').summarize).toBe(true)
  })

  it('a source that is silent about a field does not cancel the section that set it', () => {
    // The whole reason every override field is optional: `{ fetchFullText: true }` must
    // not read as `{ summarize: undefined }` and undo the section's opt-in.
    const cfg = llm({
      sections: { tech: { summarize: true } },
      sources: { lobsters: { fetchFullText: true } },
    })
    expect(resolvePolicy(cfg, 'lobsters', 'tech')).toMatchObject({
      summarize: true,
      fetchFullText: true,
    })
  })
})

describe('titleLanguage', () => {
  it('reads a headline with Latin product names in it as Chinese', () => {
    expect(titleLanguage('DeepSeek Harness 公测一周迎来多模态大招，纯文本模型也能看图了')).toBe(
      'zh',
    )
  })

  it('leaves an English headline alone', () => {
    expect(titleLanguage('Announcing Rust 1.98.0')).toBe('other')
  })

  it('does not choke on a title with no letters at all', () => {
    expect(titleLanguage('4.1.1 — 2026')).toBe('other')
  })
})

describe('passesWhen — the quality gate', () => {
  const base = llmSchema.parse({}).when

  it('is off, not closed, when neither excerpt trigger is configured', () => {
    const it0 = item({ excerpt: 'A perfectly serviceable three-line summary from the feed.' })
    expect(
      passesWhen(it0, base, { rankInSection: 0, junkPatterns: [], fetchFullText: false }),
    ).toBe(true)
  })

  it('declines an excerpt that is already long enough', () => {
    const when = { ...base, excerptShorterThan: 80 }
    const long = item({ excerpt: 'x'.repeat(120) })
    const short = item({ excerpt: 'x'.repeat(20) })
    expect(
      passesWhen(long, when, { rankInSection: 0, junkPatterns: [], fetchFullText: false }),
    ).toBe(false)
    expect(
      passesWhen(short, when, { rankInSection: 0, junkPatterns: [], fetchFullText: false }),
    ).toBe(true)
  })

  it('always passes an item with no excerpt — that is the case LLM output exists for', () => {
    const when = { ...base, excerptShorterThan: 80 }
    expect(
      passesWhen(item({}), when, { rankInSection: 0, junkPatterns: [], fetchFullText: false }),
    ).toBe(true)
  })

  it('passes a long excerpt that matches a junk fingerprint', () => {
    const when = { ...base, excerptShorterThan: 20 }
    const junk = item({ excerpt: 'This post appeared first on The GitHub Blog ' + 'x'.repeat(80) })
    const ctx = { rankInSection: 0, junkPatterns: [/appeared first on/i], fetchFullText: false }
    expect(passesWhen(junk, when, ctx)).toBe(true)
  })

  it('honours topPerSection', () => {
    const when = { ...base, topPerSection: 3 }
    const ctx = (rank: number) => ({ rankInSection: rank, junkPatterns: [], fetchFullText: false })
    expect(passesWhen(item({}), when, ctx(2))).toBe(true)
    expect(passesWhen(item({}), when, ctx(3))).toBe(false)
  })

  it('honours titleLanguageNot', () => {
    const when = { ...base, titleLanguageNot: 'zh' as const }
    const ctx = { rankInSection: 0, junkPatterns: [], fetchFullText: false }
    expect(passesWhen(item({ title: '国产大模型再降价' }), when, ctx)).toBe(false)
    expect(passesWhen(item({ title: 'Rust ships a new borrow checker' }), when, ctx)).toBe(true)
  })

  it('§9 M2 — a long excerpt no longer cancels a deliberate fetchFullText', () => {
    const when = { ...base, excerptShorterThan: 80 }
    const long = item({ excerpt: 'A perfectly serviceable teaser. ' + 'x'.repeat(200) })
    // The excerpt trigger asks "is the excerpt already as good as what we would send?".
    // Once the article is what gets sent, that question is answered by §0.2, not by the
    // teaser's length.
    expect(
      passesWhen(long, when, { rankInSection: 0, junkPatterns: [], fetchFullText: true }),
    ).toBe(true)
    expect(
      passesWhen(long, when, { rankInSection: 0, junkPatterns: [], fetchFullText: false }),
    ).toBe(false)
  })

  it('the structural caps still bite a full-text item', () => {
    const when = { ...base, topPerSection: 3, titleLanguageNot: 'zh' as const }
    const ctx = (rank: number) => ({ rankInSection: rank, junkPatterns: [], fetchFullText: true })
    expect(passesWhen(item({ title: 'English headline' }), when, ctx(3))).toBe(false)
    expect(passesWhen(item({ title: '中文标题' }), when, ctx(0))).toBe(false)
  })
})

describe('planEnrichment', () => {
  it('plans nothing at all while the block is disabled', () => {
    const plan = planEnrichment([section('tech', item({}))], llmSchema.parse({}))
    expect(plan.tasks).toHaveLength(0)
    expect(plan.gated).toBe(0)
  })

  it('counts the items the switches turned down', () => {
    const plan = planEnrichment([section('tech', item({}), item({}))], llm())
    expect(plan.tasks).toHaveLength(0)
    expect(plan.gated).toBe(2)
  })

  it('spreads a tight budget across sections instead of draining the first one', () => {
    // Three sections asking for three each, four calls to give away: section-at-a-time
    // would hand three to `a` and one to `b`, leaving `c` with nothing and no trace.
    const cfg = llm({
      sections: { a: { summarize: true }, b: { summarize: true }, c: { summarize: true } },
      budget: { maxItemsPerRun: 4 },
    })
    const three = (id: string) =>
      section(id, item({ id: `${id}1` }), item({ id: `${id}2` }), item({ id: `${id}3` }))
    const plan = planEnrichment([three('a'), three('b'), three('c')], cfg)
    expect(plan.tasks.map((t) => t.item.id)).toEqual(['a1', 'b1', 'c1', 'a2'])
    expect(plan.cappedByItems).toBe(5)
  })

  it('stops at the total character budget and says so', () => {
    const cfg = llm({
      sections: { tech: { summarize: true } },
      budget: { maxTotalInputChars: 250 },
    })
    const long = (id: string) => item({ id, excerpt: 'x'.repeat(100) })
    const plan = planEnrichment([section('tech', long('1'), long('2'), long('3'))], cfg)
    expect(plan.tasks).toHaveLength(2)
    expect(plan.cappedByChars).toBe(1)
    expect(plan.inputChars).toBe(200)
  })

  it('cuts an over-long input rather than dropping the item', () => {
    const cfg = llm({
      sections: { tech: { summarize: true } },
      budget: { maxInputCharsPerItem: 100 },
    })
    const plan = planEnrichment([section('tech', item({ excerpt: 'x'.repeat(500) }))], cfg)
    expect(plan.tasks).toHaveLength(1)
    expect(plan.tasks[0]!.input).toHaveLength(100)
  })

  it('plans the excerpt as the input — the article, if any, arrives later', () => {
    const cfg = llm({
      sections: { tech: { summarize: true } },
      sources: { 'hn-front': { fetchFullText: true } },
    })
    const plan = planEnrichment([section('tech', item({ excerpt: 'short' }))], cfg)
    // `inputKind` records what was ACTUALLY sent, and at plan time nothing has been
    // fetched yet: the extract stage flips it only when the fetch comes back.
    expect(plan.tasks[0]!.inputKind).toBe('excerpt')
    expect(plan.tasks[0]!.wantsFullText).toBe(true)
    expect(plan.tasks[0]!.policy.fetchFullText).toBe(true)
  })

  it('§9 M2 — a full-text item books its per-item ceiling before it fetches', () => {
    const cfg = llm({
      sections: { tech: { summarize: true, fetchFullText: true } },
      budget: { maxInputCharsPerItem: 1000, maxTotalInputChars: 2500 },
    })
    const short = (id: string) => item({ id, excerpt: 'x'.repeat(50) })
    const plan = planEnrichment([section('tech', short('1'), short('2'), short('3'))], cfg)
    // Three 50-char excerpts would all fit; three unfetched articles would not. Reserving
    // is what keeps `--llm-dry-run` honest about the run it is predicting.
    expect(plan.tasks).toHaveLength(2)
    expect(plan.cappedByChars).toBe(1)
    expect(plan.inputChars).toBe(2000)
    expect(plan.tasks[0]!.reservedChars).toBe(1000)
  })

  it('an excerpt-only item still books only what it will send', () => {
    const cfg = llm({
      sections: { tech: { summarize: true } },
      budget: { maxInputCharsPerItem: 1000 },
    })
    const plan = planEnrichment([section('tech', item({ excerpt: 'x'.repeat(50) }))], cfg)
    expect(plan.tasks[0]!.reservedChars).toBe(50)
  })

  it('estimates a full-text item by the script of its title, the one signal it has', () => {
    const cfg = llm({
      sections: { tech: { summarize: true, fetchFullText: true } },
      budget: { maxInputCharsPerItem: 4000 },
    })
    const english = planEnrichment(
      [section('tech', item({ title: 'A very ordinary English headline', excerpt: 'x' }))],
      cfg,
    )
    const chinese = planEnrichment(
      [section('tech', item({ title: '一条再普通不过的中文标题', excerpt: 'x' }))],
      cfg,
    )
    // Same reserved characters, four times the tokens: CJK runs about one token per
    // character where Latin runs about four characters per token.
    expect(chinese.tasks[0]!.estimatedInputTokens).toBeGreaterThan(
      english.tasks[0]!.estimatedInputTokens * 3,
    )
  })

  it('is a pure function of its inputs — same plan twice', () => {
    const cfg = llm({ sections: { tech: { summarize: true } } })
    const sections = [section('tech', item({ id: '1' }), item({ id: '2' }))]
    expect(planEnrichment(sections, cfg)).toEqual(planEnrichment(sections, cfg))
  })
})

describe('estimateTokens', () => {
  it('charges CJK roughly one token per character', () => {
    expect(estimateTokens('中文摘要测试')).toBe(6)
  })

  it('charges Latin roughly four characters per token', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
  })
})
