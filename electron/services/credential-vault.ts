import path from 'node:path'
import { chmod, readFile } from 'node:fs/promises'
import type { CredentialStorePort } from '../../src/core/contracts'
import { atomicWrite, ensureDir, formatJson, pathExists } from './file-utils'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

type VaultData = Record<string, string>

export class CredentialVault implements CredentialStorePort {
  private loaded = false
  private data: VaultData = {}

  constructor(private readonly filePath: string, private readonly safeStorage: SafeStorageLike) {}

  get storagePath(): string {
    return this.filePath
  }

  private assertAvailable(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('OS credential storage is unavailable. Enable a system keyring before saving credentials.')
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!(await pathExists(this.filePath))) return
    const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as VaultData
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Credential vault is invalid')
    this.data = parsed
  }

  async reload(): Promise<void> {
    this.loaded = false
    this.data = {}
    await this.load()
  }

  async set(ref: string, secret: string): Promise<void> {
    this.assertAvailable()
    await this.load()
    this.data[ref] = this.safeStorage.encryptString(secret).toString('base64')
    await ensureDir(path.dirname(this.filePath))
    await atomicWrite(this.filePath, formatJson(this.data), 0o600)
    await chmod(this.filePath, 0o600).catch(() => undefined)
  }

  async get(ref: string): Promise<string | undefined> {
    this.assertAvailable()
    await this.load()
    const encoded = this.data[ref]
    if (!encoded) return undefined
    return this.safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  }

  async has(ref: string): Promise<boolean> {
    await this.load()
    return Boolean(this.data[ref])
  }
}
