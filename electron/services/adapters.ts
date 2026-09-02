import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import type { AgentAdapter, AdapterContext, FileMutation, PreparedActivation, ProfileDefinition } from '../../src/core/contracts'
import type { AgentId, AgentStatus, ProfileSummary } from '../../src/shared'
import { atomicWrite, formatJson, normalizeSecret, pathExists, readText, shellQuote } from './file-utils'
import { getAgentLabel, getProfileDefinitions } from './profiles'

export type { AgentAdapter, AdapterContext, PreparedActivation } from '../../src/core/contracts'

const MANAGED_CLAUDE_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT',
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'
]

function profileToSummary(profile: ProfileDefinition, activeProfileId?: string, credentialStatus?: ProfileSummary['credentialStatus']): ProfileSummary {
  return {
    id: profile.id,
    agent: profile.agent,
    name: profile.name,
    description: profile.description,
    authKind: profile.authKind,
    endpoint: profile.endpoint,
    model: profile.model,
    availabilityModel: profile.healthProbe.requestModel,
    credentialStatus: credentialStatus ?? profile.credentialStatus,
    health: profile.id === activeProfileId ? profile.health : 'unknown',
    capabilities: profile.capabilities,
    credentialGuide: profile.credentialGuide
  }
}

function removeOpenAiApiKeyFromEnv(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:export\s+)?OPENAI_API_KEY\s*=/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n?$/, '\n')
}

function normalizeCodexManagedAuth(
  providers: Record<string, Record<string, unknown>>,
  codexDir: string,
  profiles: ProfileDefinition[]
): void {
  for (const [providerId, candidate] of Object.entries(providers)) {
    if (!candidate || typeof candidate !== 'object') continue
    const provider = candidate as Record<string, any>
    if (!provider.auth || typeof provider.auth !== 'object') continue

    // Codex 0.152.0 rejects this combination before it even resolves the
    // selected `-p` profile. Removing stale values here keeps an unrelated
    // provider (for example wzw) from blocking Official startup.
    delete provider.requires_openai_auth

    // Existing installations can carry absolute auth-command paths from a
    // different CODEX_HOME (notably an Orca account home pointing at
    // ~/.codex). Rewrite only pai-switch-managed key files and preserve any
    // provider-specific jq flags or command shape.
    const managedProfile = profiles.find((profile) => profile.id === `codex-${providerId}`)
    const args = provider.auth.args
    if (!managedProfile?.credentialPath || !Array.isArray(args)) continue
    const keyArgIndex = args.findIndex((arg: unknown) => typeof arg === 'string' && /auth\.json\.key\.[A-Za-z0-9_-]+$/.test(arg))
    if (keyArgIndex >= 0) args[keyArgIndex] = managedProfile.credentialPath
  }
}

abstract class BaseAdapter implements AgentAdapter {
  abstract readonly id: AgentId
  protected readonly profiles: ProfileDefinition[]

  constructor(protected readonly context: AdapterContext, agent: AgentId) {
    this.profiles = getProfileDefinitions(context.homeDir).filter((profile) => profile.agent === agent)
  }

  getProfiles(): ProfileDefinition[] {
    return this.profiles
  }

  protected profile(profileId: string): ProfileDefinition {
    const result = this.profiles.find((candidate) => candidate.id === profileId)
    if (!result) throw new Error(`Unknown ${this.id} profile: ${profileId}`)
    return result
  }

  /** Codex/Grok keep the live OAuth session in auth.json; .oauth is an archive. */
  private nativeOAuthPath(profile: ProfileDefinition): string | undefined {
    if ((profile.agent !== 'codex' && profile.agent !== 'grok') || !profile.configPath) return undefined
    return path.join(path.dirname(profile.configPath), 'auth.json')
  }

  private expectedOAuthMode(profile: ProfileDefinition): string | undefined {
    if (profile.agent === 'codex') return 'chatgpt'
    if (profile.agent === 'grok') return 'oauth'
    return undefined
  }

  private isExpectedOAuthContent(profile: ProfileDefinition, content: string): boolean {
    if (!content.trim()) return false
    if (profile.agent !== 'codex' && profile.agent !== 'grok') {
      try { JSON.parse(content); return true } catch { return false }
    }
    try {
      const parsed = JSON.parse(content) as { auth_mode?: unknown }
      return parsed.auth_mode === this.expectedOAuthMode(profile)
    } catch {
      return false
    }
  }

  private async readExpectedOAuth(profile: ProfileDefinition, candidate: string | undefined): Promise<string | undefined> {
    if (!candidate) return undefined
    try {
      const content = await readText(candidate)
      return content && this.isExpectedOAuthContent(profile, content) ? content : undefined
    } catch {
      return undefined
    }
  }

  protected async credentialStatus(profile: ProfileDefinition): Promise<ProfileSummary['credentialStatus']> {
    if (profile.authKind === 'none') return 'not-required'
    if (profile.authKind === 'oauth') {
      let invalidFile = false
      const nativePath = this.nativeOAuthPath(profile)
      const candidates = [nativePath, profile.oauthPath].filter((candidate, index, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === index)
      for (const candidate of candidates) {
        let content: string | undefined
        try { content = await readText(candidate) } catch { invalidFile = true; continue }
        if (content === undefined) continue
        if (this.isExpectedOAuthContent(profile, content)) return 'configured'
        invalidFile = true
      }
      if (profile.credentialRef) {
        try {
          if (await this.context.vault.has(profile.credentialRef)) return 'configured'
        } catch {
          // A missing OS keyring is reported as unknown instead of exposing a secret.
        }
      }
      return invalidFile ? 'unknown' : 'missing'
    }
    if (profile.credentialRef) {
      try {
        if (await this.context.vault.has(profile.credentialRef)) return 'configured'
      } catch {
        // A missing OS keyring is reported as unknown instead of exposing a secret.
      }
    }
    const candidate = profile.credentialPath ?? profile.oauthPath
    if (!candidate || !(await pathExists(candidate))) return 'missing'
    try {
      const content = await readFile(candidate, 'utf8')
      if (!content.trim()) return 'missing'
      if (profile.agent === 'codex' && profile.authKind === 'api-key') {
        const parsed = JSON.parse(content) as { OPENAI_API_KEY?: unknown }
        if (typeof parsed.OPENAI_API_KEY !== 'string' || !parsed.OPENAI_API_KEY.trim()) return 'missing'
      }
      if (profile.agent === 'grok' && profile.authKind === 'api-key') {
        const parsed = JSON.parse(content) as { XAI_API_KEY?: unknown }
        if (typeof parsed.XAI_API_KEY !== 'string' || !parsed.XAI_API_KEY.trim()) return 'missing'
      }
      return 'configured'
    } catch {
      return 'unknown'
    }
  }

  protected async readSecret(profile: ProfileDefinition): Promise<string | undefined> {
    if (profile.authKind === 'oauth') {
      const native = await this.readExpectedOAuth(profile, this.nativeOAuthPath(profile))
      if (native) return native
      const archived = await this.readExpectedOAuth(profile, profile.oauthPath)
      if (archived) return archived
      if (profile.credentialRef) {
        try {
          const secret = await this.context.vault.get(profile.credentialRef)
          if (secret) return secret
        } catch {
          // Fall through when the OS keyring is unavailable.
        }
      }
      return undefined
    }
    if (profile.credentialRef) {
      try {
        const secret = await this.context.vault.get(profile.credentialRef)
        if (secret) return secret
      } catch {
        // Fall through to the native credential file for existing installations.
      }
    }
    const candidate = profile.credentialPath ?? profile.oauthPath
    if (!candidate) return undefined
    const content = await readText(candidate)
    if (!content) return undefined
    if (profile.agent === 'codex' && profile.authKind === 'api-key') {
      try { return (JSON.parse(content) as { OPENAI_API_KEY?: unknown }).OPENAI_API_KEY as string | undefined } catch { return undefined }
    }
    if (profile.agent === 'grok' && profile.authKind === 'api-key') {
      try { return (JSON.parse(content) as { XAI_API_KEY?: unknown }).XAI_API_KEY as string | undefined } catch { return undefined }
    }
    return content
  }

  protected async status(activeProfileId?: string, configState: AgentStatus['configState'] = 'ready'): Promise<AgentStatus> {
    const profiles = await Promise.all(this.profiles.map(async (profile) => profileToSummary(profile, activeProfileId, await this.credentialStatus(profile))))
    return { id: this.id, label: getAgentLabel(this.id), activeProfileId, configState, profiles, updatedAt: new Date().toISOString() }
  }

  abstract inspect(activeProfileId?: string): Promise<AgentStatus>
  abstract prepareActivation(profileId: string): Promise<PreparedActivation>
  abstract loginCommand(): { command: string; args: string[] }

  async setCredential(profileId: string, secret: string): Promise<void> {
    const profile = this.profile(profileId)
    if (!profile.credentialRef || (!profile.credentialPath && !profile.oauthPath)) throw new Error('This profile does not accept a managed credential')
    const normalized = normalizeSecret(secret)
    if (!normalized) throw new Error('Credential cannot be empty')
    await this.context.vault.set(profile.credentialRef, normalized)
    const target = profile.credentialPath ?? profile.oauthPath
    if (!target) throw new Error('Credential storage path is not configured')
    if (profile.authKind === 'oauth') {
      await atomicWrite(target, normalized, 0o600)
    } else if (profile.agent === 'claude') {
      await atomicWrite(target, normalized, 0o600)
    } else if (profile.agent === 'codex') {
      await atomicWrite(target, formatJson({ auth_mode: 'apikey', OPENAI_API_KEY: normalized }), 0o600)
    } else if (profile.agent === 'grok') {
      await atomicWrite(target, formatJson({ auth_mode: 'apikey', XAI_API_KEY: normalized }), 0o600)
    } else {
      await atomicWrite(target, normalized, 0o600)
    }
  }

  async getSecret(profileId: string): Promise<string | undefined> {
    return this.readSecret(this.profile(profileId))
  }
}

export class ClaudeAdapter extends BaseAdapter {
  readonly id: AgentId = 'claude'

  constructor(context: AdapterContext) { super(context, 'claude') }

  async inspect(activeProfileId?: string): Promise<AgentStatus> {
    const settingsPath = this.profiles[0].configPath!
    const content = await readText(settingsPath)
    if (content === undefined) return this.status(activeProfileId, 'missing')
    try {
      JSON.parse(content)
      return this.status(activeProfileId)
    } catch {
      return this.status(activeProfileId, 'invalid')
    }
  }

  async prepareActivation(profileId: string): Promise<PreparedActivation> {
    const profile = this.profile(profileId)
    const configPath = profile.configPath!
    const current = await readText(configPath)
    let settings: Record<string, unknown> = {}
    if (current !== undefined) {
      try { settings = JSON.parse(current) as Record<string, unknown> } catch { throw new Error(`Invalid Claude settings JSON: ${configPath}`) }
    }
    const env = (settings.env && typeof settings.env === 'object' ? settings.env : {}) as Record<string, string>
    for (const key of MANAGED_CLAUDE_KEYS) delete env[key]
    const mutations: FileMutation[] = []
    let secret: string | undefined
    if (profile.id !== 'claude-official') {
      secret = await this.readSecret(profile)
      if (!secret) throw new Error(`Credential missing for ${profile.name}`)
      const isBai = profile.id === 'claude-bai'
      Object.assign(env, {
        ANTHROPIC_BASE_URL: profile.endpoint,
        ANTHROPIC_AUTH_TOKEN: normalizeSecret(secret),
        ANTHROPIC_MODEL: profile.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: isBai ? 'hy3' : profile.id === 'claude-qwen' ? 'qwen3.7-flash[1m]' : 'deepseek-v4-pro[1m]',
        ANTHROPIC_DEFAULT_SONNET_MODEL: isBai ? 'deepseek-v4-flash' : profile.id === 'claude-qwen' ? 'qwen3.7-plus[1m]' : 'deepseek-v4-flash[1m]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: isBai ? 'glm-5.3-flash' : profile.id === 'claude-qwen' ? 'qwen3.8-max[1m]' : 'deepseek-v4-flash',
        CLAUDE_CODE_SUBAGENT_MODEL: isBai ? 'deepseek-v4-flash' : profile.id === 'claude-qwen' ? 'qwen3.7-plus[1m]' : 'deepseek-v4-flash[1m]',
        CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1'
      })
      if (isBai) {
        env.HTTP_PROXY = 'http://127.0.0.1:7897'
        env.HTTPS_PROXY = 'http://127.0.0.1:7897'
        env.http_proxy = 'http://127.0.0.1:7897'
        env.https_proxy = 'http://127.0.0.1:7897'
      }
      settings.model = profile.model
    } else {
      delete settings.model
    }
    settings.env = env
    mutations.push({ path: configPath, content: formatJson(settings), mode: 0o600 })
    const exports = Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('\n')
    mutations.push({ path: profile.envPath!, content: `#!/usr/bin/env bash\n# Generated by pai-switch\n${exports}${exports ? '\n' : ''}`, mode: 0o600 })
    mutations.push({ path: profile.statePath!, content: `${profile.id.replace('claude-', '')}\n`, mode: 0o600 })
    return { profile, mutations, secret }
  }

  loginCommand(): { command: string; args: string[] } { return { command: 'claude', args: ['auth', 'login'] } }
}

export class CodexAdapter extends BaseAdapter {
  readonly id: AgentId = 'codex'

  constructor(context: AdapterContext) { super(context, 'codex') }

  async inspect(activeProfileId?: string): Promise<AgentStatus> {
    const configPath = this.profiles[0].configPath!
    const content = await readText(configPath)
    if (content === undefined) return this.status(activeProfileId, 'missing')
    try { parseToml(content); return this.status(activeProfileId) } catch { return this.status(activeProfileId, 'invalid') }
  }

  async prepareActivation(profileId: string): Promise<PreparedActivation> {
    const profile = this.profile(profileId)
    const configPath = profile.configPath!
    const current = await readText(configPath)
    let config: Record<string, any> = {}
    if (current !== undefined) {
      try { config = parseToml(current) as Record<string, any> } catch { throw new Error(`Invalid Codex TOML: ${configPath}`) }
    }
    const existingProviders = config.model_providers as Record<string, Record<string, unknown>> | undefined
    if (profile.id === 'codex-official' && existingProviders?.official) {
      // Migrate the legacy pai-switch custom Official provider. Codex's
      // built-in `openai` provider is the only supported ChatGPT OAuth route;
      // leaving this api.openai.com custom block behind is misleading and can
      // make an old profile appear to be an API route.
      const legacyOfficial = existingProviders.official
      if (
        legacyOfficial.base_url === 'https://api.openai.com/v1'
        && legacyOfficial.requires_openai_auth === true
        && legacyOfficial.auth_type === 'login'
        && legacyOfficial.auth === undefined
      ) delete existingProviders.official
    }
    if (existingProviders && typeof existingProviders === 'object') {
      // Repair configs generated by older versions for every provider, not
      // only the selected one. Codex validates the whole provider table before
      // loading `-p`, so one stale entry (for example Hotaru) can block an
      // otherwise unrelated Official profile.
      normalizeCodexManagedAuth(existingProviders, path.dirname(configPath), this.profiles)
    }
    // `openai` is Codex's built-in ChatGPT/OAuth provider. Keep the user-facing
    // Profile name as `official`, but never create a custom provider pointing at
    // api.openai.com: that would turn the Team route into a developer-API-like
    // custom route and can change the authentication semantics.
    const storageId = profile.id === 'codex-official' ? 'openai' : profile.id.replace('codex-', '')
    config.model_provider = storageId
    if (!config.model) config.model = profile.model ?? 'gpt-5.6-sol'
    if (profile.id !== 'codex-official') {
      if (!profile.credentialPath) throw new Error(`Credential storage path is not configured for ${profile.name}`)
      const providers = (config.model_providers ??= {}) as Record<string, Record<string, unknown>>
      const provider: Record<string, unknown> = {
        ...(providers[storageId] ?? {}),
        name: storageId,
        base_url: profile.endpoint,
        wire_api: 'responses',
        auth_type: 'key',
        model: profile.model ?? config.model,
        // Codex invokes this command only for the selected key provider. It
        // never needs to replace the global auth.json (which belongs to the
        // official ChatGPT OAuth session).
        auth: {
          command: '/usr/bin/jq',
          args: ['-r', '.OPENAI_API_KEY', profile.credentialPath],
          timeout_ms: 5000,
          refresh_interval_ms: 0
        }
      }
      // Codex 0.152.0 rejects `requires_openai_auth` whenever a provider has
      // an `auth` command. Remove stale values from older generated configs;
      // omitting the field is the valid representation for command auth.
      delete provider.requires_openai_auth
      providers[storageId] = provider
    }
    const authPath = path.join(path.dirname(configPath), 'auth.json')
    const oauthPath = path.join(path.dirname(configPath), 'auth.json.oauth')
    const envPath = path.join(path.dirname(configPath), '.env')
    const currentAuth = await readText(authPath)
    const mutations: FileMutation[] = [{ path: configPath, content: stringifyToml(config), mode: 0o600 }]
    let currentAuthMode: string | undefined
    if (currentAuth) {
      try {
        const parsed = JSON.parse(currentAuth) as { auth_mode?: string }
        currentAuthMode = parsed.auth_mode
        if (parsed.auth_mode === 'chatgpt') {
          // Keep an archive for legacy installs and for recovery after a
          // native `codex login`; this is never an API-key overwrite.
          mutations.push({ path: oauthPath, content: currentAuth, mode: 0o600 })
        }
      } catch {
        throw new Error(`Invalid Codex auth JSON: ${authPath}`)
      }
    }
    let secret: string | undefined
    if (profile.id === 'codex-official') {
      const currentEnv = await readText(envPath)
      if (currentEnv !== undefined) {
        const cleanedEnv = removeOpenAiApiKeyFromEnv(currentEnv)
        if (cleanedEnv !== currentEnv) mutations.push({ path: envPath, content: cleanedEnv, mode: 0o600 })
      }
      const oauth = await this.readSecret(profile)
      if (!oauth) throw new Error(`Credential missing for ${profile.name}; run codex login first`)
      // Restore OAuth only when switching back from a legacy API-key state.
      // If auth.json is already OAuth, leave it byte-for-byte untouched.
      if (currentAuthMode !== 'chatgpt' || currentAuth !== oauth) {
        mutations.push({ path: authPath, content: oauth, mode: 0o600 })
      }
    } else {
      secret = await this.readSecret(profile)
      if (!secret) throw new Error(`Credential missing for ${profile.name}`)
      // Store each API key in its own native key file. The selected provider's
      // auth command reads this file, so switching to Mega/custom/etc. never
      // overwrites the official OAuth auth.json.
      mutations.push({ path: profile.credentialPath!, content: formatJson({ auth_mode: 'apikey', OPENAI_API_KEY: normalizeSecret(secret) }), mode: 0o600 })
    }
    mutations.push({ path: profile.statePath!, content: `${storageId}\n`, mode: 0o600 })
    return { profile, mutations, secret }
  }

  loginCommand(): { command: string; args: string[] } { return { command: 'codex', args: ['login'] } }
}

export class AntigravityAdapter extends BaseAdapter {
  readonly id: AgentId = 'antigravity'

  constructor(context: AdapterContext) { super(context, 'antigravity') }

  async inspect(activeProfileId?: string): Promise<AgentStatus> {
    const configPath = this.profiles[0].configPath!
    const content = await readText(configPath)
    if (content === undefined) return this.status(activeProfileId, 'missing')
    try { JSON.parse(content); return this.status(activeProfileId) } catch { return this.status(activeProfileId, 'invalid') }
  }

  async prepareActivation(profileId: string): Promise<PreparedActivation> {
    const profile = this.profile(profileId)
    const current = await readText(profile.configPath!)
    let settings: Record<string, unknown> = {}
    if (current !== undefined) {
      try { settings = JSON.parse(current) as Record<string, unknown> } catch { throw new Error(`Invalid Antigravity settings JSON: ${profile.configPath}`) }
    }
    if (!settings.model) settings.model = profile.model
    const mutations: FileMutation[] = [{ path: profile.configPath!, content: formatJson(settings), mode: 0o600 }]
    const oauth = profile.oauthPath ? await readText(profile.oauthPath) : undefined
    if (oauth) mutations.push({ path: profile.oauthPath!, content: oauth, mode: 0o600 })
    return { profile, mutations }
  }

  // Antigravity has no documented `login` subcommand. Starting `agy` opens
  // the native first-run/browser authentication flow when credentials are
  // missing, and otherwise opens a normal session with the existing login.
  loginCommand(): { command: string; args: string[] } { return { command: 'agy', args: [] } }
}

export class GrokAdapter extends BaseAdapter {
  readonly id: AgentId = 'grok'

  constructor(context: AdapterContext) { super(context, 'grok') }

  async inspect(activeProfileId?: string): Promise<AgentStatus> {
    const configPath = this.profiles[0].configPath!
    const content = await readText(configPath)
    if (content === undefined) return this.status(activeProfileId, 'missing')
    try { parseToml(content); return this.status(activeProfileId) } catch { return this.status(activeProfileId, 'invalid') }
  }

  async prepareActivation(profileId: string): Promise<PreparedActivation> {
    const profile = this.profile(profileId)
    const current = await readText(profile.configPath!)
    let config: Record<string, any> = {}
    if (current !== undefined) {
      try { config = parseToml(current) as Record<string, any> } catch { throw new Error(`Invalid Grok TOML: ${profile.configPath}`) }
    }
    const authPath = path.join(path.dirname(profile.configPath!), 'auth.json')
    const oauthPath = path.join(path.dirname(profile.configPath!), 'auth.json.oauth')
    const currentAuth = await readText(authPath)
    let secret: string | undefined
    const models = (config.model ??= {}) as Record<string, Record<string, unknown>>
    if (profile.id === 'grok-official') {
      for (const modelConfig of Object.values(models)) {
        delete modelConfig.base_url
        delete modelConfig.api_key
      }
      delete config.endpoints
    } else {
      secret = await this.readSecret(profile)
      if (!secret) throw new Error(`Credential missing for ${profile.name}`)
      config.endpoints = { ...(config.endpoints ?? {}), models_base_url: profile.endpoint }
      for (const name of ['grok-4.6', 'grok-build', 'grok-4.5']) {
        models[name] = { ...(models[name] ?? {}), base_url: profile.endpoint, api_key: normalizeSecret(secret), supports_reasoning_effort: true }
      }
    }
    config.models = { ...(config.models ?? {}), default: profile.model ?? config.models?.default ?? 'grok-4.6' }
    const mutations: FileMutation[] = [{ path: profile.configPath!, content: stringifyToml(config), mode: 0o600 }]
    if (currentAuth) {
      try {
        const parsed = JSON.parse(currentAuth) as { auth_mode?: string }
        if (parsed.auth_mode === 'oauth') mutations.push({ path: oauthPath, content: currentAuth, mode: 0o600 })
      } catch {
        throw new Error(`Invalid Grok auth JSON: ${authPath}`)
      }
    }
    if (profile.id === 'grok-official') {
      const oauth = await this.readSecret(profile)
      mutations.push({ path: authPath, content: oauth ?? formatJson({ auth_mode: 'oauth' }), mode: 0o600 })
    } else {
      mutations.push({ path: authPath, content: formatJson({ auth_mode: 'apikey', XAI_API_KEY: normalizeSecret(secret!) }), mode: 0o600 })
    }
    mutations.push({ path: profile.statePath!, content: `${profile.id.replace('grok-', '')}\n`, mode: 0o600 })
    return { profile, mutations, secret }
  }

  loginCommand(): { command: string; args: string[] } { return { command: 'grok', args: ['login'] } }
}

export function createAdapters(context: AdapterContext): AgentAdapter[] {
  return [new ClaudeAdapter(context), new CodexAdapter(context), new AntigravityAdapter(context), new GrokAdapter(context)]
}
