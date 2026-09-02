export type AgentId = 'claude' | 'codex' | 'antigravity' | 'grok'
export type AuthKind = 'oauth' | 'api-key' | 'none'
export type HealthState = 'healthy' | 'unhealthy' | 'not-configured' | 'unknown' | 'checking'

export interface ProfileCapabilities {
  supportsModelTiers?: boolean
  supportsReasoningEffort?: boolean
  supportsProxy?: boolean
  supportsCredentialEdit?: boolean
  supportsNativeLogin?: boolean
}

export interface CredentialGuide {
  label: string
  help: string
}

export interface ProfileSummary {
  id: string
  agent: AgentId
  name: string
  description: string
  authKind: AuthKind
  endpoint?: string
  model?: string
  /** Model ID used by the availability probe when it differs from the native config model. */
  availabilityModel?: string
  credentialStatus: 'configured' | 'missing' | 'not-required' | 'expired' | 'unknown'
  health: HealthState
  latencyMs?: number
  healthMessage?: string
  healthStatusCode?: number
  healthCheckedAt?: string
  capabilities: ProfileCapabilities
  credentialGuide?: CredentialGuide
}

export interface AgentStatus {
  id: AgentId
  label: string
  activeProfileId?: string
  configState: 'ready' | 'missing' | 'invalid' | 'permission-denied'
  profiles: ProfileSummary[]
  updatedAt?: string
}

export interface AppState {
  agents: AgentStatus[]
}

export interface HealthResult {
  profileId: string
  state: Exclude<HealthState, 'checking'>
  latencyMs?: number
  statusCode?: number
  message: string
  checkedAt: string
}

export interface SwitchResult {
  agent: AgentId
  profileId: string
  snapshotId: string
  changedFiles: string[]
  message: string
}

export interface SnapshotSummary {
  id: string
  agent: AgentId
  createdAt: string
  profileId?: string
  fileCount: number
}

export interface LaunchSpec {
  agent: AgentId
  profileId: string
  command: string
  isolation: 'profile' | 'shared'
}

export interface PaiSwitchAPI {
  getState(): Promise<AppState>
  switchProfile(agent: AgentId, profileId: string): Promise<SwitchResult>
  setCredential(profileId: string, secret: string): Promise<void>
  testConnection(profileId: string): Promise<HealthResult>
  listSnapshots(agent: AgentId): Promise<SnapshotSummary[]>
  restoreSnapshot(agent: AgentId, snapshotId: string): Promise<void>
  launchNativeLogin(agent: AgentId): Promise<void>
  prepareLaunch(profileId: string): Promise<LaunchSpec>
  launchProfile(profileId: string): Promise<LaunchSpec>
  onChanged(listener: (state: AppState) => void): () => void
}

declare global {
  interface Window {
    paiSwitch?: PaiSwitchAPI
  }
}

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
  antigravity: 'Antigravity CLI',
  grok: 'Grok'
}

export const AGENT_ORDER: AgentId[] = ['claude', 'codex', 'antigravity', 'grok']
