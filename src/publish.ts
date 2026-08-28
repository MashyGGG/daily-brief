import { parsePublishArgs, PUBLISH_USAGE } from './publish/cli'
import { loadConfig } from './config/load'
import { ConfigError } from './config/schema'
import { lastCronOccurrence, ScheduleError } from './schedule/cron'
import { runPublish } from './publish/run'
import { renderPublishSummary } from './publish/summary'
import { createPublisher } from './publish/index'
import { writeStepOutputs, writeStepSummary } from './summary'
import { collectSecretValues, safeErrorMessage } from './core/redact'
import { resolveTarget } from './publish/adapt'
import type { HttpFetch } from './channels'
import type { PublisherContext } from './publish/types'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function main(argv: string[]): Promise<number> {
  const args = parsePublishArgs(argv)
  if (args.help) {
    console.log(PUBLISH_USAGE)
    return 0
  }

  const env = process.env
  const { config, path } = loadConfig(args.config, env)

  const ctx: PublisherContext = {
    env,
    fetchImpl: fetch as unknown as HttpFetch,
    sleep,
    log: (message: string) => console.log(message),
  }

  if (args.validateOnly) {
    console.log(
      `✓ ${path} is valid — publish ${config.publish.enabled ? 'enabled' : 'disabled'}, ` +
        `${config.publish.schedules.length} line(s), ${config.publish.targets.length} target(s)`,
    )
    for (const target of config.publish.targets) {
      const publisher = createPublisher(target.platform, ctx)
      const missing = publisher.missingEnv(resolveTarget(target, target.schedules[0] ?? ''))
      console.log(
        `  ${missing.length === 0 ? '✓' : '-'} ${target.id} (${target.platform})` +
          (missing.length > 0 ? ` — missing env: ${missing.join(', ')}` : ''),
      )
    }
    return 0
  }

  // §2.4 — the break-glass switch is a repo VARIABLE, not a config field: when something
  // goes wrong you want to stop publishing from a phone, not open a pull request.
  if (env.PUBLISH_ENABLED === 'false' || !config.publish.enabled) {
    const why =
      env.PUBLISH_ENABLED === 'false' ? 'PUBLISH_ENABLED=false' : 'publish.enabled is false'
    console.log(`[publish] disabled (${why}) — nothing to do`)
    writeStepSummary(`## publish\n\n> 已停用（${why}），本次不发布。\n`, env)
    writeStepOutputs({ 'state-commit': 'false', 'state-label': 'disabled' }, env)
    return 0
  }

  const now = new Date()
  const scheduledAt = args.cron?.trim() ? lastCronOccurrence(args.cron, now) : null
  if (scheduledAt) {
    const lagMinutes = Math.round((now.getTime() - scheduledAt.getTime()) / 60_000)
    console.log(
      `[publish] cron "${args.cron}" was due ${scheduledAt.toISOString()} — dispatched ${lagMinutes}min late`,
    )
  }

  const result = await runPublish({
    config,
    env,
    now,
    scheduledAt,
    ctx,
    ...(args.schedule ? { scheduleId: args.schedule } : {}),
    ...(args.cron ? { cron: args.cron } : {}),
    ...(args.date ? { date: args.date } : {}),
    ...(args.targets ? { targets: args.targets } : {}),
    ...(args.catchUp !== undefined ? { catchUp: args.catchUp } : {}),
    dryRun: args.dryRun,
    force: args.force,
    allowPublish: args.publish,
    noCommit: args.noCommit,
    explain: args.explain,
    log: (message: string) => console.log(message),
  })

  const summary = renderPublishSummary(result, { dryRun: args.dryRun })
  writeStepSummary(summary, env)
  console.log(summary)

  writeStepOutputs(
    {
      'state-commit': String(result.stateChanged && !args.dryRun && !args.noCommit),
      'state-label': result.stateLabel,
      'exit-code': String(result.exitCode),
    },
    env,
  )

  for (const day of result.days) {
    for (const r of day.results) {
      const icon = r.status === 'failed' ? '✗' : r.status === 'skipped' ? '-' : '✓'
      console.log(
        `${icon} ${day.publishDate} ${r.target} (${r.platform}): ${r.status}` +
          (r.detail ? ` — ${r.detail}` : ''),
      )
    }
  }

  if (result.exitCode !== 0) {
    console.error(
      '\nAt least one target failed. The state is written (failStreak is what opens the ' +
        'circuit), and the job fails so the alert fires.',
    )
  }
  return result.exitCode
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    if (err instanceof ConfigError || err instanceof ScheduleError) {
      console.error(`\n${err.message}\n`)
    } else {
      console.error(`\n${safeErrorMessage(err, collectSecretValues())}\n`)
      if (process.env.DEBUG) console.error(err)
    }
    process.exitCode = 1
  })
