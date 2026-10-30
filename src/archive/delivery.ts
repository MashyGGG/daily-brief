import type { FsLike } from './fs'
import type { DeliveryResult } from '../channels'

interface DeliveryState {
  version: 1
  date: string
  scheduleId: string
  recipients: Record<string, { status: DeliveryResult['status']; at: string }>
}

export function deliveryStatePath(dir: string, date: string, scheduleId: string): string {
  return `${dir}/delivery/${date}.${scheduleId}.json`
}

export function readDeliveryState(fs: FsLike, path: string, date: string, scheduleId: string): DeliveryState {
  const empty: DeliveryState = {version: 1, date, scheduleId, recipients: {}}
  const raw = fs.readFile(path)
  if (!raw) return empty
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('Delivery state is unreadable; review it before retrying to avoid duplicate mail.') }
  if (!value || typeof value !== 'object') throw new Error('Invalid delivery state')
  const state = value as DeliveryState
  if (state.version !== 1 || state.date !== date || state.scheduleId !== scheduleId ||
      !state.recipients || typeof state.recipients !== 'object' || Array.isArray(state.recipients) ||
      Object.values(state.recipients).some(r => !r || !['sent', 'failed', 'skipped'].includes(r.status) || typeof r.at !== 'string')) {
    throw new Error('Invalid delivery state; review it before retrying to avoid duplicate mail.')
  }
  return state
}

/** Store no addresses, credential-bearing errors, or message bodies. */
export function saveDeliveryResults(fs: FsLike, path: string, state: DeliveryState, results: DeliveryResult[], at: string): void {
  for (const result of results) state.recipients[result.recipient] = {status: result.status, at}
  fs.writeFile(path, JSON.stringify(state, null, 2) + '\n')
}
