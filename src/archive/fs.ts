import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * The archive layer takes its filesystem as an injected dependency so the unit tests
 * exercise the real path/index logic without ever writing a temp directory (§6).
 */
export interface FsLike {
  readFile(path: string): string | null
  writeFile(path: string, data: string): void
  readdir(path: string): string[]
  isDirectory(path: string): boolean
  exists(path: string): boolean
}

export const nodeFs: FsLike = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  writeFile(path, data) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data, 'utf8')
  },
  readdir(path) {
    try {
      return readdirSync(path).sort()
    } catch {
      return []
    }
  },
  isDirectory(path) {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  exists(path) {
    return existsSync(path)
  },
}

/** An in-memory FsLike, used by the tests and by `--dry-run` when nothing may be written. */
export function memoryFs(initial: Record<string, string> = {}): FsLike & {
  files: Map<string, string>
} {
  const files = new Map(Object.entries(initial))
  const dirsOf = (path: string): string[] => {
    const prefix = path.endsWith('/') ? path : `${path}/`
    const names = new Set<string>()
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const head = rest.split('/')[0]
      if (head) names.add(head)
    }
    return [...names].sort()
  }
  return {
    files,
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, data) => {
      files.set(path, data)
    },
    readdir: dirsOf,
    isDirectory: (path) => dirsOf(path).length > 0,
    exists: (path) => files.has(path) || dirsOf(path).length > 0,
  }
}
