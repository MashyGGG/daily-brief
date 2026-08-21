export interface CliArgs {
  config: string
  schedule?: string
  cron?: string
  sections?: string[]
  recipients?: string[]
  fromArchive?: string
  dryRun: boolean
  noCommit: boolean
  validateOnly: boolean
  /** §9 M3 — the weekly review: aggregate the archived issues, send, fetch nothing. */
  weekly: boolean
  /** `YYYY-MM-DD` the weekly window ends on; today in the config timezone when unset. */
  weeklyEnding?: string
  /** Kill switch for the LLM stage; the brief still goes out (§6.1). */
  noLlm: boolean
  /** Plan the LLM calls and print them without making any. */
  llmDryRun: boolean
  /** `YYYY-MM-DD` — re-summarize an archived issue to evaluate a prompt change. */
  reEnrich?: string
  /** With --re-enrich: print the source excerpt next to the new summary. */
  diff: boolean
  help: boolean
}

export const USAGE = `daily-brief — build and push the daily brief

usage: pnpm brief [options]

  --config <path>          config file (default: brief.config.yaml)
  --schedule <id>          which schedule to run (required when several are enabled)
  --cron "<cron>"          reverse-look-up the schedule from the firing cron
                           (the workflow passes \${{ github.event.schedule }} here)
  --sections a,b           only these sections (intersected with the schedule's own list)
  --recipients a,b         only these recipients
  --from-archive YYYY-MM-DD  re-send an archived issue; fetches nothing, archives nothing
  --weekly [YYYY-MM-DD]    weekly review built from the archived issues (weekly.days back
                           from the given date, or from today); fetches nothing, archived
                           under the "weekly" slot
  --dry-run                render to stdout only: no push, no archive, no network to channels
  --no-commit              archive normally but tell the workflow not to commit
  --validate-only          load and validate the config, then exit
  --no-llm                 skip the LLM stage; every item keeps its source excerpt
  --llm-dry-run            list the items that would be summarized (+ token estimate), call nothing
  --re-enrich YYYY-MM-DD   re-summarize an archived issue; prints only, sends and writes nothing
  --diff                   with --re-enrich: print excerpt vs summary side by side
  -h, --help               this text
`

function list(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const items = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    config: 'brief.config.yaml',
    dryRun: false,
    noCommit: false,
    validateOnly: false,
    weekly: false,
    noLlm: false,
    llmDryRun: false,
    diff: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      return value
    }
    switch (arg) {
      case '--config':
        args.config = next()
        break
      case '--schedule':
        args.schedule = next()
        break
      case '--cron':
        args.cron = next()
        break
      case '--sections':
        args.sections = list(next())
        break
      case '--recipients':
        args.recipients = list(next())
        break
      case '--from-archive':
        args.fromArchive = next()
        break
      case '--weekly': {
        args.weekly = true
        // The date is optional, so it is taken only when the next argument actually looks
        // like one — `--weekly --dry-run` must not swallow the flag behind it.
        const peek = argv[i + 1]
        if (peek && /^\d{4}-\d{2}-\d{2}$/.test(peek)) {
          args.weeklyEnding = peek
          i++
        }
        break
      }
      case '--dry-run':
        args.dryRun = true
        break
      case '--no-commit':
        args.noCommit = true
        break
      case '--validate-only':
        args.validateOnly = true
        break
      case '--no-llm':
        args.noLlm = true
        break
      case '--llm-dry-run':
        args.llmDryRun = true
        break
      case '--re-enrich':
        args.reEnrich = next()
        break
      case '--diff':
        args.diff = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      default:
        // An empty --cron "" from the workflow (manual dispatch) must not look like a flag.
        if (arg.startsWith('--')) throw new Error(`unknown option "${arg}"`)
    }
  }

  if (args.fromArchive && !/^\d{4}-\d{2}-\d{2}$/.test(args.fromArchive)) {
    throw new Error(`--from-archive expects YYYY-MM-DD, got "${args.fromArchive}"`)
  }
  if (args.reEnrich && !/^\d{4}-\d{2}-\d{2}$/.test(args.reEnrich)) {
    throw new Error(`--re-enrich expects YYYY-MM-DD, got "${args.reEnrich}"`)
  }
  if (args.diff && !args.reEnrich) throw new Error('--diff only means something with --re-enrich')
  if (args.weekly && args.fromArchive) {
    throw new Error('--weekly and --from-archive both replay the archive; pick one')
  }
  return args
}
