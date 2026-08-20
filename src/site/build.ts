import { nodeFs } from '../archive/fs'
import { DEFAULT_CONFIG_PATH, loadConfig } from '../config/load'
import { ConfigError } from '../config/schema'
import { collectIssues, sectionsOf } from './collect'
import {
  SITE_CSS,
  renderFeed,
  renderIndexPage,
  renderIssuePage,
  renderLatestRedirect,
  renderNotFound,
} from './render'

/**
 * Compile `archive/**\/*.json` into a static site.
 *
 * The site is a derived view: it is never committed, and deleting it costs nothing.
 * That is also why this entry point only ever READS the archive.
 *
 *   pnpm site:build [--out site] [--config brief.config.yaml] [--base-url https://…/]
 */

interface SiteArgs {
  out: string
  config: string
  baseUrl: string
  archiveDir: string | null
}

export function parseSiteArgs(argv: string[]): SiteArgs {
  const args: SiteArgs = { out: 'site', config: DEFAULT_CONFIG_PATH, baseUrl: '', archiveDir: null }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1] ?? ''
    switch (flag) {
      case '--out':
        args.out = value
        i++
        break
      case '--config':
        args.config = value
        i++
        break
      case '--base-url':
        args.baseUrl = value
        i++
        break
      case '--archive-dir':
        args.archiveDir = value
        i++
        break
      case '--help':
      case '-h':
        console.log(
          'daily-brief site builder\n\n' +
            '  --out <dir>          output directory (default: site)\n' +
            '  --config <path>      config file (default: brief.config.yaml)\n' +
            '  --base-url <url>     absolute base, used by feed.xml (default: relative)\n' +
            '  --archive-dir <dir>  override the config archive dir\n',
        )
        process.exit(0)
        break
      default:
        throw new Error(`Unknown flag "${flag}"`)
    }
  }
  return args
}

function main(): void {
  const args = parseSiteArgs(process.argv.slice(2))
  const { config } = loadConfig(args.config)
  const archiveDir = args.archiveDir ?? config.archive.dir
  const siteTitle = config.title
  const builtAt = new Date().toISOString()

  const { issues, skipped } = collectIssues(archiveDir, nodeFs)
  const titles = Object.fromEntries(config.sections.map((s) => [s.id, s.title]))
  const order = config.sections.map((s) => s.id)

  const write = (path: string, data: string): void => nodeFs.writeFile(`${args.out}/${path}`, data)

  issues.forEach((issue, i) => {
    write(
      issue.path,
      renderIssuePage({
        siteTitle,
        issue,
        sections: sectionsOf(issue.record, titles, order),
        older: issues[i + 1],
        newer: issues[i - 1],
      }),
    )
  })

  write('index.html', renderIndexPage({ siteTitle, issues, builtAt }))
  write('latest.html', renderLatestRedirect(issues[0], siteTitle))
  write('404.html', renderNotFound(siteTitle))
  write('feed.xml', renderFeed({ siteTitle, issues, baseUrl: args.baseUrl, builtAt }))
  write('assets/style.css', SITE_CSS)
  // Belt and braces: the artifact deploy does not run Jekyll, but a branch deploy would.
  write('.nojekyll', '')

  console.log(`site: ${issues.length} issue(s) from ${archiveDir}/ -> ${args.out}/`)
  if (skipped.length > 0) {
    console.warn(`site: skipped ${skipped.length} unreadable archive file(s):`)
    for (const path of skipped) console.warn(`  - ${path}`)
  }
  if (issues.length === 0) {
    console.warn('site: no archived issues yet — the index will say so rather than fail')
  }
}

try {
  main()
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message)
    process.exit(2)
  }
  console.error(`site build failed: ${(err as Error).message}`)
  process.exit(1)
}
