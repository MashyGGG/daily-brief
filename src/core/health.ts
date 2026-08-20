import { DEFAULT_STALE_AFTER_DAYS, type Source } from '../config/schema'
import type { SourceOutcome } from '../sources'

/**
 * §3.2 — the second half of failure isolation.
 *
 * `fetchAll` already warns when a source *throws*. It cannot warn about the failure mode
 * that actually happens in the wild: a feed that answers 200 with a well-formed body and
 * then quietly stops publishing. Two measured on 2026-08-20 while evaluating candidates:
 * the 联合早报 mirror was 22 days stale and CoolShell 1200 days — both returning valid
 * documents, both of which a transport-level check reports as ✅.
 *
 * So health is judged on the CONTENT, not the transport, on two signals:
 *   - a 200 that parsed into zero items — nothing legitimate ever does this
 *   - a newest entry older than the source's own `staleAfterDays` budget
 *
 * Both are warnings, never failures: a stale source must not take the brief down with it.
 *
 * Caveat worth knowing before you trust a green run: `normalize()` stamps undated entries
 * with `now`, so a feed that ships no per-item dates at all can never look stale here.
 * Every source we track does ship dates (probed 2026-08-20) — re-check that when adding one.
 */

export interface StaleFinding {
  source: string
  /** Age of the newest item, in days. `null` when the source returned nothing at all. */
  ageDays: number | null
  thresholdDays: number
}

export function staleAfterDaysOf(source: Source): number {
  return source.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS
}

function ageInDays(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / 86_400_000
}

/**
 * Sources whose *content* looks unhealthy. Sources that failed outright are skipped —
 * they already carry a fetch warning, and a second line about the same source is noise.
 */
export function findStaleSources(
  outcomes: SourceOutcome[],
  sources: Source[],
  now: Date,
): StaleFinding[] {
  const budgets = new Map(sources.map((s) => [s.name, staleAfterDaysOf(s)]))
  const findings: StaleFinding[] = []

  for (const outcome of outcomes) {
    if (outcome.error) continue
    const thresholdDays = budgets.get(outcome.source) ?? DEFAULT_STALE_AFTER_DAYS

    if (outcome.items.length === 0) {
      findings.push({ source: outcome.source, ageDays: null, thresholdDays })
      continue
    }

    const newest = outcome.latestPublishedAt
    if (!newest) continue
    const age = ageInDays(newest, now)
    if (!Number.isFinite(age)) continue
    if (age > thresholdDays) {
      findings.push({ source: outcome.source, ageDays: age, thresholdDays })
    }
  }

  return findings
}

/** One line per finding, in the same voice as the fetch-failure warnings. */
export function describeStale(finding: StaleFinding): string {
  if (finding.ageDays === null) {
    return `source "${finding.source}" returned 0 items (HTTP was fine — the feed itself is empty or unparseable)`
  }
  return (
    `source "${finding.source}" looks stale: newest item is ${finding.ageDays.toFixed(0)} days old ` +
    `(budget ${finding.thresholdDays}d)`
  )
}

export function healthWarnings(outcomes: SourceOutcome[], sources: Source[], now: Date): string[] {
  return findStaleSources(outcomes, sources, now).map(describeStale)
}
