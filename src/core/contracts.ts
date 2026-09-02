import type { AgentId, AgentStatus, AppState, HealthResult, LaunchSpec, ProfileSummary, SnapshotSummary, SwitchResult } from '../shared'

/** A planned filesystem change. The core never performs the write itself. */
export interface FileMutation {
  path: string
  content: string | null
  mode?: number
}

export interface HealthProbeDefinition {
  url: string
  method: 'GET' | 'POST'
  kind?: 'authenticated-get' | 'anthropic-messages' | 'openai-responses'
  /** Provider API model ID. It may differ from ProfileSummary.model used by the native CLI. */
  requestModel?: string
  auth?: 'bearer' | 'x-api-key' | 'none'
  headers?: Record<string, string>
  proxy?: string
  timeoutMs?: number
}

/** Native paths are data carried by the definition; only the desktop adapter resolves them. */
export interface ProfileDefinition extends ProfileSummary {
  credentialRef?: string
  credentialPath?: string
  oauthPath?: string
  configPath?: string
  statePath?: string
  envPath?: string
  healthProbe: HealthProbeDefinition
}

export interface CredentialStorePort {
  readonly storagePath: string
  set(ref: string, secret: string): Promise<void>
  get(ref: string): Promise<string | undefined>
  has(ref: string): Promise<boolean>
  reload(): Promise<void>
}

export interface AdapterContext {
  homeDir: string
  vault: CredentialStorePort
}

export interface PreparedActivation {
  profile: ProfileDefinition
  mutations: FileMutation[]
  secret?: string
}

/** Stable seam consumed by the manager and renderer-facing IPC, independent of Electron. */
export interface AgentAdapter {
  readonly id: AgentId
  getProfiles(): ProfileDefinition[]
  inspect(activeProfileId?: string): Promise<AgentStatus>
  prepareActivation(profileId: string): Promise<PreparedActivation>
  setCredential(profileId: string, secret: string): Promise<void>
  getSecret(profileId: string): Promise<string | undefined>
  loginCommand(): { command: string; args: string[] }
}

export interface AgentManagerPort {
  getState(): Promise<AppState>
  switchProfile(agent: AgentId, profileId: string): Promise<SwitchResult>
  setCredential(profileId: string, secret: string): Promise<void>
  testConnection(profileId: string): Promise<HealthResult>
  listSnapshots(agent: AgentId): Promise<SnapshotSummary[]>
  restoreSnapshot(agent: AgentId, snapshotId: string): Promise<void>
  launchNativeLogin(agent: AgentId): Promise<void>
  prepareLaunch(profileId: string): Promise<LaunchSpec>
  launchProfile(profileId: string): Promise<LaunchSpec>
}
