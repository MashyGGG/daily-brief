export interface PublishCliArgs {
  config: string
  schedule?: string
  cron?: string
  date?: string
  targets?: string[]
  /** Overrides the line's `catchUpDays`; `0` means "only today". */
  catchUp?: number
  dryRun: boolean
  force: boolean
  /** Allow the real publish step even where `autoPublish` is off. */
  publish: boolean
  noCommit: boolean
  explain: boolean
  validateOnly: boolean
  help: boolean
}

export const PUBLISH_USAGE = `daily-brief publish — cross-post an archived window to Notion / 掘金

usage: pnpm publish:run [options]

  --config <path>      config file (default: brief.config.yaml)
  --schedule <id>      which publishing line to run (daily / weekly); default: daily
  --cron "<cron>"      reverse-look-up the line from the firing cron
                       (the workflow passes \${{ github.event.schedule }} here)
  --date YYYY-MM-DD    the publication date (default: today in the config timezone)
  --targets a,b        only these targets, overriding the config's enabled set
  --catch-up <n>       override catchUpDays; 0 = only the given date
  --dry-run            select and render to stdout: no platform call, no state written
  --force              ignore the contentHash check and update anyway
  --publish            allow the real publish step (temporarily equivalent to autoPublish)
  --no-commit          do not write *.publish.json (pairs with --dry-run)
  --explain            print the selection table: what each issue contributed and why
  --validate-only      check the config and the targets' secrets, then exit
  -h, --help           this text
`

function list(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const items = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function parsePublishArgs(argv: string[]): PublishCliArgs {
  const args: PublishCliArgs = {
    config: 'brief.config.yaml',
    dryRun: false,
    force: false,
    publish: false,
    noCommit: false,
    explain: false,
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
      case '--date':
        args.date = next()
        break
      case '--targets':
        args.targets = list(next())
        break
      case '--catch-up': {
        const raw = next()
        const parsed = Number(raw)
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error(`--catch-up expects a non-negative integer, got "${raw}"`)
        }
        args.catchUp = parsed
        break
      }
      case '--dry-run':
        args.dryRun = true
        break
      case '--force':
        args.force = true
        break
      case '--publish':
        args.publish = true
        break
      case '--no-commit':
        args.noCommit = true
        break
      case '--explain':
        args.explain = true
        break
      case '--validate-only':
        args.validateOnly = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      default:
        // An empty --cron "" from a manual dispatch must not look like a flag.
        if (arg.startsWith('--')) throw new Error(`unknown option "${arg}"`)
    }
  }

  if (args.date && !DATE_RE.test(args.date)) {
    throw new Error(`--date expects YYYY-MM-DD, got "${args.date}"`)
  }
  if (args.schedule && args.cron) {
    throw new Error('--schedule and --cron both name a publishing line; pass one')
  }
  return args
}
