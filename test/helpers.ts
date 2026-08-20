import type { Item, RawItem } from '../src/config/schema'

export const NOW = new Date('2026-08-20T00:30:00.000Z')

/** A minimal valid config, as YAML, with the interesting bits overridable per test. */
export function configYaml(overrides: Partial<Record<string, string>> = {}): string {
  const base: Record<string, string> = {
    head: `timezone: Asia/Shanghai
title: 每日早报
schedules:
  - id: morning
    time: '08:00'
    lookbackHours: 24
`,
    sources: `sources:
  - name: hn-front
    type: hackernews
    weight: 1.2
    params: { mode: front_page, minPoints: 100 }
  - name: verge
    type: rss
    params: { url: https://www.theverge.com/rss/index.xml }
`,
    sections: `sections:
  - id: tech
    title: 国际技术
    sources: [hn-front]
    limit: 8
  - id: news
    title: 国际要闻
    sources: [verge]
    limit: 5
`,
    recipients: `recipients:
  - id: me-wecom
    channel: wecom
    secretRef: WECOM_WEBHOOK_ME
    sections: [tech, news]
`,
    archive: '',
  }
  const merged = { ...base, ...overrides }
  return [merged.head, merged.sources, merged.sections, merged.archive, merged.recipients].join('')
}

let seq = 0

export function rawItem(partial: Partial<RawItem> = {}): RawItem {
  seq++
  return {
    id: partial.id ?? `id-${seq}`,
    title: partial.title ?? `Item ${seq}`,
    url: partial.url ?? `https://example.com/${seq}`,
    source: partial.source ?? 'hn-front',
    publishedAt: partial.publishedAt ?? NOW.toISOString(),
    ...(partial.score !== undefined ? { score: partial.score } : {}),
    ...(partial.author ? { author: partial.author } : {}),
    ...(partial.excerpt ? { excerpt: partial.excerpt } : {}),
  }
}

export function item(partial: Partial<Item> = {}): Item {
  return {
    ...rawItem(partial),
    section: partial.section ?? 'tech',
    rankScore: partial.rankScore ?? 0.5,
  }
}
