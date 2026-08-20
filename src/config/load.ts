import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { ConfigError, parseConfig, type BriefConfig } from './schema'

export const DEFAULT_CONFIG_PATH = 'brief.config.yaml'

export interface LoadedConfig {
  config: BriefConfig
  /** Hash of the raw YAML — recorded in the archive JSON so a past issue can be traced to its config. */
  configHash: string
  path: string
}

export function loadConfig(
  path: string = DEFAULT_CONFIG_PATH,
  env: NodeJS.ProcessEnv = process.env,
): LoadedConfig {
  const abs = resolve(path)
  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch (err) {
    throw new ConfigError(`Cannot read config at ${abs}: ${(err as Error).message}`)
  }
  return {
    config: parseConfig(text, env),
    configHash: createHash('sha256').update(text).digest('hex').slice(0, 12),
    path: abs,
  }
}
