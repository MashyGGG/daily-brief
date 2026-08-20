import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfig, DEFAULT_CONFIG_PATH } from '../config/load'
import { applyScheduleBlock, hasDst, generateCrons, ScheduleError } from './cron'
import { ConfigError } from '../config/schema'

export const WORKFLOW_PATH = '.github/workflows/daily-brief.yml'

/**
 * `pnpm brief:schedule` rewrites the workflow's cron block from brief.config.yaml.
 * `pnpm check:schedule` only compares and exits non-zero on drift (A17) — so changing the
 * time and forgetting to regenerate is caught in CI, not on the morning the brief goes missing.
 */
function main(argv: string[]): number {
  const write = argv.includes('--write')
  const check = argv.includes('--check')
  if (write === check) {
    console.error('usage: brief:schedule --write | --check [--config <path>] [--workflow <path>]')
    return 2
  }

  const configPath = valueOf(argv, '--config') ?? DEFAULT_CONFIG_PATH
  const workflowPath = resolve(valueOf(argv, '--workflow') ?? WORKFLOW_PATH)

  const { config } = loadConfig(configPath)
  const before = readFileSync(workflowPath, 'utf8')
  const after = applyScheduleBlock(before, config)

  if (hasDst(config.timezone)) {
    console.warn(
      `[warn] timezone "${config.timezone}" observes daylight saving time. A cron is a fixed UTC ` +
        `instant, so the generated schedule will be one hour off for part of the year. ` +
        `Regenerate at each DST transition, or pick a zone with a fixed offset.`,
    )
  }

  for (const entry of generateCrons(config)) {
    const state = entry.enabled ? 'enabled ' : 'disabled'
    console.log(`  ${state}  ${entry.cron}  # ${entry.comment}`)
  }

  if (check) {
    if (before === after) {
      console.log(`✓ ${WORKFLOW_PATH} is in sync with ${configPath}`)
      return 0
    }
    console.error(
      `\n✗ ${WORKFLOW_PATH} is out of sync with ${configPath}.\n` +
        `  Run "pnpm brief:schedule" and commit the regenerated workflow.\n\n` +
        diff(before, after),
    )
    return 1
  }

  if (before === after) {
    console.log(`✓ ${WORKFLOW_PATH} already up to date`)
    return 0
  }
  writeFileSync(workflowPath, after, 'utf8')
  console.log(`✓ wrote ${WORKFLOW_PATH}`)
  return 0
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
