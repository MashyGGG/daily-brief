import { describe, expect, it } from 'vitest'
import { memoryFs } from '../src/archive/fs'
import { publishTargetSchema, type PublishTarget } from '../src/config/schema'
import {
  afterFailure,
  afterSuccess,
  decide,
  parseState,
  publishedItemIds,
  readState,
  setTargetState,
  statePath,
  upsertLine,
  writeState,
  type TargetState,
} from '../src/publish/state'
import type { CollectedIssue } from '../src/publish/types'

const target = (over: Record<string, unknown> = {}): PublishTarget =>
  publishTargetSchema.parse({
    id: 'juejin',
    platform: 'juejin',
    secretRef: 'JUEJIN_COOKIE',
    juejin: { categoryId: '1', tagIds: ['a'] },
    ...over,
  })

const stored = (over: Partial<TargetState> = {}): TargetState => ({
  platform: 'juejin',
  status: 'draft',
  postId: 'p1',
  contentHash: 'HASH',
  attempts: 1,
  failStreak: 0,
  updatedAt: '2026-08-22T00:00:00.000Z',
  ...over,
})

const article = { contentHash: 'HASH' }
const changed = { contentHash: 'OTHER' }

/** PUBLISH.md §4.2 — the decision table, one case per row. */
describe('publish/state — decide()', () => {
  it('creates when there is no record at all', () => {
    expect(decide({ target: target(), article, editablePublished: false })).toMatchObject({
      action: 'create',
    })
  })

  it('skips a draft whose content has not changed — the foundation of re-running safely', () => {
    const d = decide({ target: target(), article, state: stored(), editablePublished: false })
    expect(d.action).toBe('skip')
    expect(d.postId).toBe('p1')
  })

  it('updates a draft whose selection has changed', () => {
    const d = decide({
      target: target(),
      article: changed,
      state: stored(),
      editablePublished: false,
    })
    expect(d).toMatchObject({ action: 'update', postId: 'p1' })
  })

  it('updates an already-published Notion page: a mirror is meant to stay in sync', () => {
    const d = decide({
      target: publishTargetSchema.parse({
        id: 'notion-archive',
        platform: 'notion',
        secretRef: 'NOTION_TOKEN',
        notion: { dataSourceRef: 'NOTION_DATA_SOURCE_ID' },
      }),
      article: changed,
      state: stored({ platform: 'notion', status: 'published' }),
      editablePublished: true,
    })
    expect(d.action).toBe('update')
  })

  it('will NOT silently rewrite a 掘金 post that is already public', () => {
    const d = decide({
      target: target(),
      article: changed,
      state: stored({ status: 'published' }),
      editablePublished: false,
    })
    expect(d.action).toBe('skip')
    expect(d.warn).toBe(true)
  })

  it('retries a failure while the streak is below the limit', () => {
    const d = decide({
      target: target({ failStreakLimit: 3 }),
      article,
      state: stored({ status: 'failed', failStreak: 2 }),
      editablePublished: false,
    })
    expect(d).toMatchObject({ action: 'update', postId: 'p1' })
  })

  it('opens the circuit at the limit rather than hammering a rate limiter', () => {
    const d = decide({
      target: target({ failStreakLimit: 3 }),
      article,
      state: stored({ status: 'failed', failStreak: 3 }),
      editablePublished: false,
    })
    expect(d.action).toBe('halt')
    expect(d.warn).toBe(true)
    expect(d.reason).toMatch(/--force/)
  })

  it('opens the circuit even when the first create never produced a postId', () => {
    const d = decide({
      target: target({ failStreakLimit: 2 }),
      article,
      state: stored({ status: 'failed', failStreak: 2, postId: undefined }),
      editablePublished: false,
    })
    expect(d.action).toBe('halt')
  })

  it('--force overrides every skip and every open circuit', () => {
    expect(
      decide({ target: target(), article, state: stored(), force: true, editablePublished: false }),
    ).toMatchObject({ action: 'update', postId: 'p1' })

    expect(
      decide({
        target: target({ failStreakLimit: 1 }),
        article,
        state: stored({ status: 'failed', failStreak: 9 }),
        force: true,
        editablePublished: false,
      }).action,
    ).toBe('update')
  })
})

describe('publish/state — the failure counter', () => {
  it('resets the streak on success and increments it on failure', () => {
    const first = afterFailure(undefined, { platform: 'juejin', error: 'boom', at: 'T1' })
    expect(first).toMatchObject({ status: 'failed', attempts: 1, failStreak: 1 })

    const second = afterFailure(first, { platform: 'juejin', error: 'boom', at: 'T2' })
    expect(second).toMatchObject({ attempts: 2, failStreak: 2 })

    const ok = afterSuccess(second, {
      platform: 'juejin',
      status: 'draft',
      postId: 'p9',
      contentHash: 'H',
      at: 'T3',
    })
    expect(ok).toMatchObject({ status: 'draft', attempts: 3, failStreak: 0, lastError: null })
  })

  it('keeps the previous postId across a failure so the retry updates rather than duplicates', () => {
    const previous = stored({ postId: 'keep-me' })
    expect(afterFailure(previous, { platform: 'juejin', error: 'x', at: 'T' }).postId).toBe(
      'keep-me',
    )
  })
})

describe('publish/state — persistence', () => {
  const issue: CollectedIssue = {
    scheduleId: 'daily',
    publishDate: '2026-08-22',
    sources: [{ date: '2026-08-22', slot: 'morning' }],
    sections: [],
    itemIds: ['a', 'b'],
    range: '2026-08-22',
  }

  it('files the state next to the content it was built from', () => {
    expect(statePath('archive', '2026-08-22')).toBe('archive/2026/08/2026-08-22.publish.json')
  })

  it('round-trips a line and its targets', () => {
    const fs = memoryFs()
    let state = upsertLine(null, '2026-08-22', issue, 'HASH')
    state = setTargetState(state, 'daily', 'juejin', stored())
    writeState('archive', state, fs, [])

    const back = readState('archive', '2026-08-22', fs)!
    expect(back.lines.daily!.itemIds).toEqual(['a', 'b'])
    expect(back.lines.daily!.targets.juejin!.postId).toBe('p1')
  })

  it('redacts before writing — this repo is public and lastError can carry a Cookie', () => {
    const fs = memoryFs()
    let state = upsertLine(null, '2026-08-22', issue, 'HASH')
    state = setTargetState(
      state,
      'daily',
      'juejin',
      afterFailure(undefined, {
        platform: 'juejin',
        error: 'rejected with cookie sessionid=SUPERSECRETVALUE',
        at: 'T',
      }),
    )
    writeState('archive', state, fs, ['SUPERSECRETVALUE'])

    const raw = fs.readFile(statePath('archive', '2026-08-22'))!
    expect(raw).not.toContain('SUPERSECRETVALUE')
    expect(raw).toContain('[REDACTED]')
  })

  it('treats a corrupt state file as "no record" instead of crashing the line', () => {
    expect(parseState('{not json')).toBeNull()
    expect(parseState('{"nope": 1}')).toBeNull()
    expect(parseState(null)).toBeNull()

    const fs = memoryFs({ 'archive/2026/08/2026-08-22.publish.json': 'garbage' })
    expect(readState('archive', '2026-08-22', fs)).toBeNull()
  })

  it('collects every published item id across days, for backfill dedupe', () => {
    const fs = memoryFs()
    writeState(
      'archive',
      upsertLine(null, '2026-08-21', { ...issue, publishDate: '2026-08-21', itemIds: ['x'] }, 'H'),
      fs,
      [],
    )
    writeState('archive', upsertLine(null, '2026-08-22', issue, 'H'), fs, [])
    const ids = publishedItemIds('archive', ['2026-08-22', '2026-08-21'], fs)
    expect([...ids].sort()).toEqual(['a', 'b', 'x'])
  })
})
