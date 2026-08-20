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
  --dry-run                render to stdout only: no push, no archive, no network to channels
  --no-commit              archive normally but tell the workflow not to commit
  --validate-only          load and validate the config, then exit
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
      case '--dry-run':
        args.dryRun = true
        break
      case '--no-commit':
        args.noCommit = true
        break
      case '--validate-only':
        args.validateOnly = true
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
  return args
}
