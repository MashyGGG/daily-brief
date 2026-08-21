import { parseArgs, USAGE } from './cli'
import { loadConfig } from './config/load'
import { ConfigError } from './config/schema'
import { findRunByCron, ScheduleError } from './schedule/cron'
import { run } from './core/pipeline'
import { renderRunSummary, writeStepOutputs, writeStepSummary } from './summary'
import { collectSecretValues, safeErrorMessage } from './core/redact'
import type { ChannelContext, HttpFetch } from './channels'
import type { FetchLike } from './sources'
import { replayEnrich } from './enrich/replay'
import type { LlmFetch } from './enrich/llm'
import type { ExtractFetch } from './enrich/extract'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(USAGE)
    return 0
  }

  const env = process.env
  const { config, configHash, path } = loadConfig(args.config, env)

  if (args.validateOnly) {
    console.log(
      `✓ ${path} is valid — ${config.schedules.length} schedule(s), ${config.sources.length} source(s), ` +
        `${config.sections.length} section(s), ${config.recipients.length} recipient(s)`,
    )
    return 0
  }

  if (args.reEnrich) {
    const replay = await replayEnrich({
      config,
      date: args.reEnrich,
      env,
      fetchImpl: fetch as unknown as LlmFetch,
      extractFetchImpl: fetch as unknown as ExtractFetch,
      diff: args.diff,
      noLlm: args.noLlm,
      llmDryRun: args.llmDryRun,
      describeError: (err) => safeErrorMessage(err, collectSecretValues(env)),
      log: (message: string) => console.log(`[brief] ${message}`),
    })
    console.log(replay.report)
    return replay.found ? 0 : 1
  }

  const channelContext: ChannelContext = {
    env,
    fetchImpl: fetch as unknown as HttpFetch,
    sleep,
    log: (message: string) => console.log(message),
  }

  // The workflow passes whichever cron fired; the weekly's is one of them (§9 M3), and
  // only this lookup can tell the two apart before the run starts.
  const weekly =
    args.weekly || (Boolean(args.cron?.trim()) && findRunByCron(config, args.cron!).weekly)

  const result = await run({
    config,
    configHash,
    now: new Date(),
    env,
    scheduleId: args.schedule,
    cron: args.cron,
    weekly,
    weeklyEnding: args.weeklyEnding,
    sections: args.sections,
    recipients: args.recipients,
    fromArchive: args.fromArchive,
    dryRun: args.dryRun,
    fetchImpl: fetch as unknown as FetchLike,
    llmFetchImpl: fetch as unknown as LlmFetch,
    extractFetchImpl: fetch as unknown as ExtractFetch,
    noLlm: args.noLlm,
    llmDryRun: args.llmDryRun,
    channelContext,
    log: (message: string) => console.log(`[brief] ${message}`),
  })

  const summary = renderRunSummary(result, { dryRun: args.dryRun })
  writeStepSummary(summary, env)
  if (!args.dryRun) console.log(summary)

  // The workflow only makes an archive commit when this says so (config `archive.commit`).
  writeStepOutputs(
    {
      'archive-commit': String(
        Boolean(result.archived) && config.archive.commit && !args.noCommit && !args.dryRun,
      ),
      'archive-date': result.brief.date,
      'item-count': String(result.brief.sections.reduce((n, s) => n + s.items.length, 0)),
      empty: String(result.empty),
    },
    env,
  )

  for (const delivery of result.deliveries) {
    const icon = delivery.status === 'sent' ? '✓' : delivery.status === 'skipped' ? '-' : '✗'
    console.log(
      `${icon} ${delivery.recipient} (${delivery.channel}): ${delivery.status}` +
        (delivery.detail ? ` — ${delivery.detail}` : ''),
    )
  }

  if (result.exitCode !== 0) {
    console.error(
      '\nAt least one recipient failed. The content is archived; the job fails so the alert fires.',
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
