import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, lstat } from 'node:fs/promises'
import path from 'node:path'
import type { FileMutation } from '../../src/core/contracts'

export type { FileMutation } from '../../src/core/contracts'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

export async function readText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export async function atomicWrite(filePath: string, content: string, mode = 0o600): Promise<void> {
  const parent = path.dirname(filePath)
  await ensureDir(parent)

  try {
    const current = await lstat(filePath)
    if (current.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${filePath}`)
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
  }

  const tempPath = `${filePath}.pai-switch-${process.pid}-${randomBytes(6).toString('hex')}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tempPath, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.chmod(mode)
    await handle.close()
    handle = undefined
    await rename(tempPath, filePath)
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

export async function applyMutation(mutation: FileMutation): Promise<void> {
  if (mutation.content === null) {
    await rm(mutation.path, { force: true })
    return
  }
  await atomicWrite(mutation.path, mutation.content, mutation.mode ?? 0o600)
}

export function parseJson<T>(content: string, filePath: string): T {
  try {
    return JSON.parse(content) as T
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function normalizeSecret(value: string): string {
  return value.trim()
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await ensureDir(path.dirname(lockPath))
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Another configuration change is already in progress')
    }
    throw error
  }

  try {
    return await fn()
  } finally {
    await handle.close().catch(() => undefined)
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}
