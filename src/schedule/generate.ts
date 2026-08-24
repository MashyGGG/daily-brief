import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfig, DEFAULT_CONFIG_PATH } from '../config/load'
import {
  applyScheduleBlock,
  hasDst,
  generateCrons,
  generatePublishCrons,
  ScheduleError,
  WORKFLOWS,
  type ScheduleKind,
} from './cron'
import { ConfigError } from '../config/schema'

export const WORKFLOW_PATH = WORKFLOWS.brief

/**
 * `pnpm brief:schedule` rewrites daily-brief.yml's cron block from brief.config.yaml, and
 * `pnpm publish:schedule` does the same for publish.yml (PUBLISH.md §7.2).
 * `pnpm check:schedule` only compares, and exits non-zero on drift (A17) — so changing a
 * time and forgetting to regenerate is caught in CI, not on the morning the brief goes
 * missing. It checks BOTH workflows: with two files and four crons, "forgot one" stopped
 * being a hypothetical.
 */
function main(argv: string[]): number {
  const write = argv.includes('--write')
  const check = argv.includes('--check')
  if (write === check) {
    console.error(
      'usage: brief:schedule --write | --check [--kind brief|publish] [--config <path>] [--workflow <path>]',
    )
    return 2
  }

  const configPath = valueOf(argv, '--config') ?? DEFAULT_CONFIG_PATH
  const kindRaw = valueOf(argv, '--kind')
  if (kindRaw !== undefined && kindRaw !== 'brief' && kindRaw !== 'publish') {
    console.error(`unknown --kind "${kindRaw}" (expected brief | publish)`)
    return 2
  }
  const kindArg: ScheduleKind | undefined = kindRaw
  const workflowOverride = valueOf(argv, '--workflow')

  const { config } = loadConfig(configPath)

  if (hasDst(config.timezone)) {
    console.warn(
      `[warn] timezone "${config.timezone}" observes daylight saving time. A cron is a fixed UTC ` +
        `instant, so the generated schedule will be one hour off for part of the year. ` +
        `Regenerate at each DST transition, or pick a zone with a fixed offset.`,
    )
  }

  // Writing targets one workflow (the two npm scripts each name their own); checking
  // covers every one unless the caller narrowed it.
  const kinds: ScheduleKind[] = kindArg ? [kindArg] : write ? ['brief'] : ['brief', 'publish']

  let drifted = 0
  for (const kind of kinds) {
    const workflowPath = resolve(
      kinds.length === 1 ? (workflowOverride ?? WORKFLOWS[kind]) : WORKFLOWS[kind],
    )
    const label = WORKFLOWS[kind]

    let before: string
    try {
      before = readFileSync(workflowPath, 'utf8')
    } catch (err) {
      // A publish workflow that is not there yet is a genuine mismatch, not a crash —
      // say which command creates it.
      console.error(`✗ cannot read ${label}: ${(err as Error).message}`)
      drifted++
      continue
    }
    const after = applyScheduleBlock(before, config, kind)

    const crons =
      kind === 'publish'
        ? generatePublishCrons(config).map((c) => ({
            enabled: c.enabled,
            cron: c.cron,
            comment: c.comment,
          }))
        : generateCrons(config).map((c) => ({
            enabled: c.enabled,
            cron: c.cron,
            comment: c.comment,
          }))
    console.log(`${label}:`)
    for (const entry of crons) {
      const state = entry.enabled ? 'enabled ' : 'disabled'
      console.log(`  ${state}  ${entry.cron}  # ${entry.comment}`)
    }

    if (check) {
      if (before === after) {
        console.log(`✓ ${label} is in sync with ${configPath}`)
        continue
      }
      console.error(
        `\n✗ ${label} is out of sync with ${configPath}.\n` +
          `  Run "pnpm ${kind === 'publish' ? 'publish:schedule' : 'brief:schedule'}" and commit the regenerated workflow.\n\n` +
          diff(before, after),
      )
      drifted++
      continue
    }

    if (before === after) {
      console.log(`✓ ${label} already up to date`)
      continue
    }
    writeFileSync(workflowPath, after, 'utf8')
    console.log(`✓ wrote ${label}`)
  }

  return drifted > 0 ? 1 : 0
}

function valueOf(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  if (at === -1) return undefined
  return argv[at + 1]
}

/** Minimal line diff, just enough to show what the drift is. */
function diff(before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  const out: string[] = []
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue
    if (a[i] !== undefined) out.push(`  - ${a[i]}`)
    if (b[i] !== undefined) out.push(`  + ${b[i]}`)
  }
  return out.join('\n')
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  if (err instanceof ConfigError || err instanceof ScheduleError) {
    console.error(err.message)
    process.exitCode = 1
  } else {
    throw err
  }
}
