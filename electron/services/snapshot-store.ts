import { readFile, lstat, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AgentId, SnapshotSummary } from '../../src/shared'
import { atomicWrite, ensureDir, formatJson, pathExists, readText, type FileMutation } from './file-utils'

interface SnapshotFile {
  target: string
  blob: string
  mode: number
  exists: boolean
}

interface SnapshotManifest {
  id: string
  agent: AgentId
  profileId?: string
  createdAt: string
  files: SnapshotFile[]
}

export class SnapshotStore {
  constructor(private readonly rootDir: string) {}

  private snapshotDir(id: string): string {
    return path.join(this.rootDir, 'snapshots', id)
  }

  async create(agent: AgentId, targets: string[], profileId?: string): Promise<SnapshotSummary> {
    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`
    const dir = this.snapshotDir(id)
    await ensureDir(dir)
    const files: SnapshotFile[] = []

    for (const target of [...new Set(targets)]) {
      const exists = await pathExists(target)
      if (!exists) {
        files.push({ target, blob: '', mode: 0o600, exists: false })
        continue
      }
      const fileStat = await lstat(target)
      if (fileStat.isSymbolicLink()) throw new Error(`Refusing to snapshot symlink: ${target}`)
      if (!fileStat.isFile()) throw new Error(`Snapshot target is not a file: ${target}`)
      const blob = `${files.length}.snapshot`
      const content = await readFile(target, 'utf8')
      await atomicWrite(path.join(dir, blob), content, 0o600)
      files.push({ target, blob, mode: fileStat.mode & 0o777, exists: true })
    }

    const manifest: SnapshotManifest = { id, agent, profileId, createdAt: new Date().toISOString(), files }
    await atomicWrite(path.join(dir, 'manifest.json'), formatJson(manifest), 0o600)
    return { id, agent, profileId, createdAt: manifest.createdAt, fileCount: files.length }
  }

  async list(agent: AgentId): Promise<SnapshotSummary[]> {
    const root = path.join(this.rootDir, 'snapshots')
    try {
      const entries = await (await import('node:fs/promises')).readdir(root, { withFileTypes: true })
      const result: SnapshotSummary[] = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const manifest = await this.readManifest(entry.name)
        if (manifest?.agent === agent) {
          result.push({ id: manifest.id, agent: manifest.agent, profileId: manifest.profileId, createdAt: manifest.createdAt, fileCount: manifest.files.length })
        }
      }
      return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async restore(agent: AgentId, id: string): Promise<void> {
    const manifest = await this.readManifest(id)
    if (!manifest || manifest.agent !== agent) throw new Error('Snapshot was not found for this Agent')
    for (const file of manifest.files) {
      if (!file.exists) {
        await (await import('node:fs/promises')).rm(file.target, { force: true })
        continue
      }
      const content = await readText(path.join(this.snapshotDir(id), file.blob))
      if (content === undefined) throw new Error(`Snapshot blob is missing: ${file.blob}`)
      await atomicWrite(file.target, content, file.mode)
    }
  }

  async readManifest(id: string): Promise<SnapshotManifest | undefined> {
    const content = await readText(path.join(this.snapshotDir(id), 'manifest.json'))
    if (!content) return undefined
    try {
      const parsed = JSON.parse(content) as SnapshotManifest
      if (!parsed.id || !parsed.agent || !Array.isArray(parsed.files)) throw new Error('Invalid snapshot manifest')
      return parsed
    } catch (error) {
      throw new Error(`Invalid snapshot manifest ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
