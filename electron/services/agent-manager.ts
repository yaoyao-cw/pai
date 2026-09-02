import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import type { AgentAdapter, AgentManagerPort, CredentialStorePort, ProfileDefinition } from '../../src/core/contracts'
import type { AgentId, AgentStatus, AppState, HealthResult, LaunchSpec, SnapshotSummary, SwitchResult } from '../../src/shared'
import { AGENT_ORDER } from '../../src/shared'
import { applyMutation, atomicWrite, formatJson, pathExists, readText, shellQuote, withLock } from './file-utils'
import { createAdapters } from './adapters'
import { getAgentLabel, getProfileDefinitions } from './profiles'
import { testProfileConnection } from './health-check'
import { SnapshotStore } from './snapshot-store'

interface ActiveProfiles {
  [agent: string]: string | undefined
}

/**
 * Native login must target pai-switch's managed home, not an inherited
 * CODEX_HOME/GROK_HOME/CLAUDE_CONFIG_DIR (for example Orca's account home).
 * Keep this mapping explicit so adding a new Agent cannot silently widen the
 * login scope.
 */
export function nativeLoginHomeAssignment(agent: AgentId, homeDir: string): string | undefined {
  if (agent === 'codex') return `CODEX_HOME=${shellQuote(path.join(homeDir, '.codex'))}`
  if (agent === 'grok') return `GROK_HOME=${shellQuote(path.join(homeDir, '.grok'))}`
  if (agent === 'claude') return `CLAUDE_CONFIG_DIR=${shellQuote(path.join(homeDir, '.claude'))}`
  return undefined
}

export class AgentManager implements AgentManagerPort {
  private readonly adapters: Map<AgentId, AgentAdapter>
  private readonly snapshots: SnapshotStore
  private readonly activeStatePath: string
  private readonly stateLockPath: string
  private activeProfiles: ActiveProfiles = {}
  private readonly healthCache = new Map<string, HealthResult>()
  private readonly listeners = new Set<(state: AppState) => void>()
  private watchers: ReturnType<typeof watch>[] = []

  constructor(private readonly homeDir: string, private readonly appDataDir: string, private readonly vault: CredentialStorePort) {
    this.adapters = new Map(createAdapters({ homeDir, vault }).map((adapter) => [adapter.id, adapter]))
    this.snapshots = new SnapshotStore(appDataDir)
    this.activeStatePath = path.join(appDataDir, 'active-profiles.json')
    this.stateLockPath = path.join(appDataDir, 'locks', 'active-state.lock')
  }

  async initialize(): Promise<void> {
    const content = await readText(this.activeStatePath)
    if (content) {
      try { this.activeProfiles = JSON.parse(content) as ActiveProfiles } catch { this.activeProfiles = {} }
    }
    for (const agent of AGENT_ORDER) {
      const known = this.adapters.get(agent)?.getProfiles().some((profile) => profile.id === this.activeProfiles[agent])
      if (!known) this.activeProfiles[agent] = await this.detectActiveProfile(agent)
    }
    await atomicWrite(this.activeStatePath, formatJson(this.activeProfiles), 0o600)
    this.startWatchers()
  }

  onChanged(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    this.listeners.clear()
  }

  async getState(): Promise<AppState> {
    await this.syncActiveProfiles()
    const agents = await Promise.all(AGENT_ORDER.map(async (agent) => this.withHealth(await this.adapters.get(agent)!.inspect(this.activeProfiles[agent]))))
    return { agents }
  }

  async switchProfile(agent: AgentId, profileId: string): Promise<SwitchResult> {
    const adapter = this.adapters.get(agent)
    if (!adapter) throw new Error(`Unsupported Agent: ${agent}`)
    return this.withAgentLock(agent, () => this.activateLocked(adapter, profileId))
  }

  async setCredential(profileId: string, secret: string): Promise<void> {
    const adapter = this.findAdapterForProfile(profileId)
    const profile = adapter.getProfiles().find((candidate) => candidate.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    if (!profile.capabilities.supportsCredentialEdit) throw new Error('This profile is managed by native login')
    await this.withAgentLock(profile.agent, async () => {
      const targets = this.mutationTargets(profile)
      const snapshot = await this.snapshots.create(profile.agent, targets, this.activeProfiles[profile.agent])
      try {
        await adapter.setCredential(profileId, secret)
        if (this.activeProfiles[profile.agent] === profileId) await this.applyPrepared(adapter, profileId)
      } catch (error) {
        await this.snapshots.restore(profile.agent, snapshot.id).catch(() => undefined)
        await this.vault.reload().catch(() => undefined)
        throw error
      }
      this.emitChanged()
    })
  }

  async testConnection(profileId: string): Promise<HealthResult> {
    const adapter = this.findAdapterForProfile(profileId)
    const profile = adapter.getProfiles().find((candidate) => candidate.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    // Native login flows may update the encrypted vault after the app has
    // already initialized. Reload before probing so “登录后检测” observes the
    // newly written credential without requiring an app restart.
    await this.vault.reload().catch(() => undefined)
    const secret = await adapter.getSecret(profileId)
    const result = await testProfileConnection(profile, secret)
    this.healthCache.set(profileId, result)
    this.emitChanged()
    return result
  }

  async listSnapshots(agent: AgentId): Promise<SnapshotSummary[]> {
    return this.snapshots.list(agent)
  }

  async restoreSnapshot(agent: AgentId, snapshotId: string): Promise<void> {
    await this.withAgentLock(agent, async () => {
      await this.snapshots.restore(agent, snapshotId)
      await this.vault.reload().catch(() => undefined)
      const content = await readText(this.activeStatePath)
      if (content) {
        try { this.activeProfiles = JSON.parse(content) as ActiveProfiles } catch { /* keep in-memory state */ }
      }
      this.emitChanged()
    })
  }

  async launchNativeLogin(agent: AgentId): Promise<void> {
    const adapter = this.adapters.get(agent)
    if (!adapter) throw new Error(`Unsupported Agent: ${agent}`)
    const login = adapter.loginCommand()
    // Login is intentionally visible and interactive. Claude/Codex/Grok may
    // print browser or device-code instructions, while agy has no `login`
    // subcommand and authenticates on a normal first run.
    const command = [login.command, ...login.args].map((part) => shellQuote(part)).join(' ')
    const managedHome = nativeLoginHomeAssignment(agent, this.homeDir)
    const cleanInheritedApiKey = agent === 'codex' ? 'env -u OPENAI_API_KEY ' : ''
    await this.openTerminal(`PAI_SWITCH_LOGIN=1 ${cleanInheritedApiKey}${managedHome ?? ''}${managedHome ? ' ' : ''}${command}`)
    await this.vault.reload().catch(() => undefined)
    this.emitChanged()
  }

  async prepareLaunch(profileId: string): Promise<LaunchSpec> {
    const adapter = this.findAdapterForProfile(profileId)
    const profile = adapter.getProfiles().find((candidate) => candidate.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return this.withAgentLock(profile.agent, () => this.prepareLaunchLocked(adapter, profile))
  }

  async launchProfile(profileId: string): Promise<LaunchSpec> {
    const spec = await this.prepareLaunch(profileId)
    await this.openTerminal(spec.command)
    return spec
  }

  private async activateLocked(adapter: AgentAdapter, profileId: string): Promise<SwitchResult> {
    const prepared = await adapter.prepareActivation(profileId)
    const targetPaths = [...this.mutationTargets(prepared.profile), this.activeStatePath]
    const snapshot = await this.snapshots.create(adapter.id, targetPaths, this.activeProfiles[adapter.id])
    const nextActive = { ...this.activeProfiles, [adapter.id]: profileId }
    prepared.mutations.push({ path: this.activeStatePath, content: formatJson(nextActive), mode: 0o600 })
    try {
      for (const mutation of prepared.mutations) await applyMutation(mutation)
      this.activeProfiles = nextActive
    } catch (error) {
      await this.snapshots.restore(adapter.id, snapshot.id).catch(() => undefined)
      throw new Error(`Switch failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.emitChanged()
    return {
      agent: adapter.id,
      profileId,
      snapshotId: snapshot.id,
      changedFiles: prepared.mutations.map((mutation) => path.basename(mutation.path)),
      message: `${prepared.profile.name} is active for new sessions`
    }
  }

  private withAgentLock<T>(agent: AgentId, fn: () => Promise<T>): Promise<T> {
    return withLock(this.stateLockPath, () => withLock(path.join(this.appDataDir, 'locks', `${agent}.lock`), fn))
  }

  private async applyPrepared(adapter: AgentAdapter, profileId: string): Promise<void> {
    const prepared = await adapter.prepareActivation(profileId)
    for (const mutation of prepared.mutations) await applyMutation(mutation)
  }

  private async prepareLaunchLocked(adapter: AgentAdapter, profile: ProfileDefinition): Promise<LaunchSpec> {
    if (profile.agent === 'antigravity') {
      const model = profile.model ? ` --model ${profile.model}` : ''
      return { agent: profile.agent, profileId: profile.id, command: `agy${model}`, isolation: 'shared' }
    }

    const prepared = await adapter.prepareActivation(profile.id)
    const runtimeDir = path.join(this.appDataDir, 'run-profiles', profile.agent, profile.id)

    if (profile.agent === 'claude') {
      const settings = prepared.mutations.find((mutation) => path.basename(mutation.path) === 'settings.json')
      if (!settings?.content) throw new Error(`Unable to prepare launch settings for ${profile.name}`)
      const settingsPath = path.join(runtimeDir, 'settings.json')
      await atomicWrite(settingsPath, settings.content, 0o600)
      // Claude Code resolves OAuth/session state from CLAUDE_CONFIG_DIR. Keep
      // the profile launch self-contained instead of silently falling back to
      // the user's global ~/.claude credentials.
      if (profile.oauthPath) {
        const credentials = await readText(profile.oauthPath)
        if (credentials) await atomicWrite(path.join(runtimeDir, '.credentials.json'), credentials, 0o600)
      }
      return {
        agent: profile.agent,
        profileId: profile.id,
        command: `CLAUDE_CONFIG_DIR=${this.shellPath(runtimeDir)} claude --settings ${this.shellPath(settingsPath)}`,
        isolation: 'profile'
      }
    }

    const allowedFiles = new Set(['config.toml', 'auth.json'])
    let configContent: string | undefined
    let credentialContent: string | undefined
    for (const mutation of prepared.mutations) {
      const fileName = path.basename(mutation.path)
      if (!allowedFiles.has(fileName) || mutation.content === null) continue
      if (fileName === 'config.toml') configContent = mutation.content
      await atomicWrite(path.join(runtimeDir, fileName), mutation.content, mutation.mode ?? 0o600)
    }

    const homeVariable = profile.agent === 'codex' ? 'CODEX_HOME' : 'GROK_HOME'
    const binary = profile.agent === 'codex' ? 'codex' : 'grok'
    if (profile.agent === 'codex') {
      const alias = this.codexProfileAlias(profile)
      if (!configContent) throw new Error(`Unable to prepare Codex profile for ${profile.name}`)
      if (profile.authKind === 'oauth') {
        // CODEX_HOME points the process at the isolated runtime directory, so
        // an already-active global OAuth file must be copied explicitly. The
        // activation planner may omit an auth.json mutation when the native
        // file is already OAuth and byte-for-byte current.
        const runtimeAuthPath = path.join(runtimeDir, 'auth.json')
        const runtimeAuth = prepared.mutations.find((mutation) => path.basename(mutation.path) === 'auth.json')?.content
        const oauth = runtimeAuth ?? await adapter.getSecret(profile.id)
        if (!oauth) throw new Error(`Credential missing for ${profile.name}; run codex login first`)
        await atomicWrite(runtimeAuthPath, oauth, 0o600)
      }
      if (profile.authKind === 'api-key' && profile.credentialPath) {
        credentialContent = prepared.mutations.find((mutation) => mutation.path === profile.credentialPath)?.content ?? undefined
        if (!credentialContent) throw new Error(`Unable to prepare Codex credential for ${profile.name}`)
        const runtimeCredentialPath = path.join(runtimeDir, path.basename(profile.credentialPath))
        await atomicWrite(runtimeCredentialPath, credentialContent, 0o600)
        const runtimeConfig = parseToml(configContent) as Record<string, any>
        const provider = runtimeConfig.model_providers?.[alias] as Record<string, any> | undefined
        if (!provider?.auth || !Array.isArray(provider.auth.args)) {
          throw new Error(`Unable to prepare Codex auth command for ${profile.name}`)
        }
        provider.auth.args = ['-r', '.OPENAI_API_KEY', runtimeCredentialPath]
        configContent = stringifyToml(runtimeConfig)
        await atomicWrite(path.join(runtimeDir, 'config.toml'), configContent, 0o600)
      }
      // Codex resolves -p <alias> as $CODEX_HOME/<alias>.config.toml.
      await atomicWrite(path.join(runtimeDir, `${alias}.config.toml`), configContent, 0o600)
      return {
        agent: profile.agent,
        profileId: profile.id,
        command: `env -u OPENAI_API_KEY ${homeVariable}=${this.shellPath(runtimeDir)} ${binary} -p ${alias}`,
        isolation: 'profile'
      }
    }
    const model = profile.model ? ` --model ${profile.model}` : ''
    return {
      agent: profile.agent,
      profileId: profile.id,
      command: `${homeVariable}=${this.shellPath(runtimeDir)} ${binary}${model}`,
      isolation: 'profile'
    }
  }

  private codexProfileAlias(profile: ProfileDefinition): string {
    const alias = profile.id.replace(/^codex-/, '')
    if (!/^[A-Za-z0-9_-]+$/.test(alias)) throw new Error(`Invalid Codex profile alias: ${alias}`)
    return alias
  }

  private shellPath(filePath: string): string {
    const relative = path.relative(this.homeDir, filePath)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && /^[A-Za-z0-9_./-]+$/.test(relative)) {
      return `~/${relative}`
    }
    return shellQuote(filePath)
  }

  private async openTerminal(command: string): Promise<void> {
    const candidates = [
      { path: '/usr/bin/gnome-terminal', args: ['--', '/bin/bash', '-lc'] },
      { path: '/usr/bin/konsole', args: ['-e', '/bin/bash', '-lc'] },
      { path: '/usr/bin/wezterm', args: ['start', '--', '/bin/bash', '-lc'] },
      { path: '/usr/bin/x-terminal-emulator', args: ['-e', '/bin/bash', '-lc'] },
      { path: '/usr/bin/xterm', args: ['-e', '/bin/bash', '-lc'] }
    ]
    let terminal: (typeof candidates)[number] | undefined
    for (const candidate of candidates) {
      try {
        await access(candidate.path)
        terminal = candidate
        break
      } catch {
        // Try the next known terminal.
      }
    }
    if (!terminal) throw new Error('No supported terminal emulator was found')

    const script = `${command}; status=$?; printf '\n[pai-switch] Agent exited with status %s.\n' "$status"; exec "${'$'}{SHELL:-/bin/bash}" -l`
    const child = spawn(terminal.path, [...terminal.args, script], {
      cwd: this.homeDir,
      detached: true,
      stdio: 'ignore',
      shell: false,
      env: { ...process.env, PAI_SWITCH_LAUNCH: '1' }
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (error) => reject(new Error(`Unable to open a terminal: ${error.message}`)))
    })
    child.unref()
  }

  private mutationTargets(profile: ProfileDefinition): string[] {
    const targets = [profile.configPath, profile.statePath, profile.envPath, profile.credentialPath, profile.oauthPath].filter((value): value is string => Boolean(value))
    if (profile.configPath) targets.push(path.join(path.dirname(profile.configPath), 'auth.json'))
    if (profile.agent === 'codex' && profile.configPath) targets.push(path.join(path.dirname(profile.configPath), '.env'))
    if (profile.agent === 'codex' || profile.agent === 'grok') targets.push(path.join(path.dirname(profile.configPath!), 'auth.json.oauth'))
    targets.push(this.vault.storagePath)
    targets.push(this.activeStatePath)
    return targets
  }

  private findAdapterForProfile(profileId: string): AgentAdapter {
    for (const adapter of this.adapters.values()) if (adapter.getProfiles().some((profile) => profile.id === profileId)) return adapter
    throw new Error(`Unknown profile: ${profileId}`)
  }

  private async detectActiveProfile(agent: AgentId): Promise<string | undefined> {
    const definitions = getProfileDefinitions(this.homeDir).filter((profile) => profile.agent === agent)
    const statePath = definitions.find((profile) => profile.statePath)?.statePath
    const state = statePath ? (await readText(statePath))?.trim() : undefined
    if (agent === 'claude') {
      const candidate = state ? `claude-${state}` : undefined
      return definitions.some((profile) => profile.id === candidate) ? candidate : definitions[0]?.id
    }
    if (agent === 'codex') {
      const mapping: Record<string, string> = {
        openai: 'codex-official',
        // Legacy pai-switch builds wrote the user-facing name here. Treat it
        // as Official during migration, but all new writes use `openai`.
        official: 'codex-official',
        'official-api': 'codex-official-api',
        mega: 'codex-mega',
        custom: 'codex-custom',
        sharedchat: 'codex-sharedchat',
        hotaru: 'codex-hotaru',
        wzw: 'codex-wzw'
      }
      const candidate = mapping[state ?? '']
      return definitions.some((profile) => profile.id === candidate) ? candidate : definitions[0]?.id
    }
    if (agent === 'grok') {
      const candidate = state === 'mega' ? 'grok-mega' : 'grok-official'
      return definitions.some((profile) => profile.id === candidate) ? candidate : definitions[0]?.id
    }
    return definitions[0]?.id
  }

  private async syncActiveProfiles(): Promise<void> {
    await Promise.all(AGENT_ORDER.map(async (agent) => {
      const detected = await this.detectActiveProfile(agent)
      if (detected && this.adapters.get(agent)?.getProfiles().some((profile) => profile.id === detected)) this.activeProfiles[agent] = detected
    }))
  }

  private withHealth(status: AgentStatus): AgentStatus {
    return {
      ...status,
      profiles: status.profiles.map((profile) => {
        const health = this.healthCache.get(profile.id)
        return {
          ...profile,
          health: health?.state ?? profile.health,
          latencyMs: health?.latencyMs,
          healthMessage: health?.message,
          healthStatusCode: health?.statusCode,
          healthCheckedAt: health?.checkedAt
        }
      })
    }
  }

  private emitChanged(): void {
    void this.getState().then((state) => this.listeners.forEach((listener) => listener(state))).catch(() => undefined)
  }

  private startWatchers(): void {
    const watchedDirs = new Set<string>()
    for (const adapter of this.adapters.values()) {
      for (const profile of adapter.getProfiles()) {
        for (const target of [profile.configPath, profile.statePath, profile.envPath, profile.credentialPath, profile.oauthPath]) {
          if (target) watchedDirs.add(path.dirname(target))
        }
      }
    }
    for (const dir of watchedDirs) {
      try {
        this.watchers.push(watch(dir, { persistent: false }, () => this.emitChanged()))
      } catch {
        // Missing Agent directories are represented as "missing" in the UI.
      }
    }
  }
}
