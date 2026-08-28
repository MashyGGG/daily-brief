/**
 * What the failure alert SAYS. Kept apart from `src/alert.ts` so it can be tested without
 * the entry point's side effects — the same split `src/publish.ts` / `src/publish/` uses.
 */
import { loadConfig } from '../config/load'
import { localDate } from '../core/brief'
import { slotLabel } from '../archive/paths'
import { findRunByCron, findScheduleById, lastCronOccurrence } from '../schedule/cron'
import { collectSecretValues, redact } from '../core/redact'

export interface AlertMessage {
  subject: string
  /** WeCom markdown; the mail body is this with the `**` stripped. */
  content: string
}

/**
 * Which edition failed, in words a reader recognises. Returns null when it cannot be
 * known — a manual run with no inputs, or a config so broken it will not parse, which is
 * itself a plausible reason for the failure. The alert must still go out in that case,
 * so every step here is allowed to fail quietly.
 */
export function failedEdition(
  env: NodeJS.ProcessEnv,
  // Injectable for the same reason `fetchImpl` and `fs` are elsewhere: the interesting
  // case here is the loader THROWING, which no environment variable can produce.
  load: typeof loadConfig = loadConfig,
): { label: string; date: string } | null {
  try {
    const { config } = load(undefined, env)
    const cron = env.ALERT_CRON?.trim()
    const id = env.ALERT_SCHEDULE?.trim()
    if (!cron && !id) return null

    const found = cron ? findRunByCron(config, cron) : null
    const schedule = found ? found.schedule : findScheduleById(config, id!)
    // Dated like the issue it would have been (docs/SCHEDULE-DRIFT.md §4): an alert for a
    // run GitHub dispatched at 02:00 still names the 19:10 edition it belongs to.
    const at = (cron ? lastCronOccurrence(cron, new Date()) : null) ?? new Date()
    return {
      label: found?.weekly ? config.weekly.title : slotLabel(schedule.id),
      date: localDate(at, config.timezone),
    }
  } catch {
    return null
  }
}

export function composeAlert(env: NodeJS.ProcessEnv, load?: typeof loadConfig): AlertMessage {
  const repo = env.GITHUB_REPOSITORY ?? 'daily-brief'
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
      : '(local run)'
  const reason = redact(env.ALERT_REASON ?? 'job failed', collectSecretValues(env))

  const edition = failedEdition(env, load)
  // Same naming rule as the issue itself (`editionSubject`): the distinguishing word
  // first, so four failed editions do not arrive as four identical alerts.
  const what = edition ? `${edition.label} 失败 · ${edition.date}` : '今日早报失败'

  return {
    subject: `[daily-brief] ${what}`,
    content: [
      `**⚠️ ${what}**`,
      `仓库：${repo}`,
      `原因：${reason}`,
      `日志：[查看运行](${runUrl})`,
    ].join('\n'),
  }
}
