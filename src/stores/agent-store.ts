import { create } from 'zustand'
import type { AgentId, AppState, HealthResult, LaunchSpec, SnapshotSummary, SwitchResult } from '../shared'
import { AGENT_ORDER } from '../shared'
import { presentError } from '../core/user-errors'

interface AgentStore {
  state: AppState
  selectedAgent: AgentId
  loading: boolean
  error?: string
  notice?: string
  snapshots: SnapshotSummary[]
  launchSpecs: Record<string, LaunchSpec>
  preparingProfileId?: string
  runningProfileId?: string
  checkingProfileId?: string
  refresh(): Promise<void>
  switchProfile(agent: AgentId, profileId: string): Promise<SwitchResult | undefined>
  setCredential(profileId: string, secret: string): Promise<void>
  testConnection(profileId: string): Promise<HealthResult | undefined>
  loadSnapshots(agent: AgentId): Promise<void>
  restoreSnapshot(agent: AgentId, snapshotId: string): Promise<void>
  launchLogin(agent: AgentId): Promise<void>
  prepareLaunch(profileId: string): Promise<LaunchSpec | undefined>
  launchProfile(profileId: string): Promise<void>
  selectAgent(agent: AgentId): void
  subscribeExternal(): () => void
  clearError(): void
  clearNotice(): void
}

function api() {
  if (!window.paiSwitch) throw new Error('pai-switch API is unavailable')
  return window.paiSwitch
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  state: { agents: [] },
  selectedAgent: 'claude',
  loading: false,
  error: undefined,
  notice: undefined,
  snapshots: [],
  launchSpecs: {},
  preparingProfileId: undefined,
  runningProfileId: undefined,
  checkingProfileId: undefined,

  async refresh(): Promise<void> {
    set({ loading: true, error: undefined })
    try {
      set({ state: await api().getState() })
    } catch (cause) {
      set({ error: userMessage(cause, get().state) })
    } finally {
      set({ loading: false })
    }
  },

  async switchProfile(agent: AgentId, profileId: string): Promise<SwitchResult | undefined> {
    set({ loading: true, error: undefined, notice: undefined })
    try {
      const result = await api().switchProfile(agent, profileId)
      set({ notice: result.message, state: await api().getState() })
      return result
    } catch (cause) {
      set({ error: userMessage(cause, get().state, profileId) })
      return undefined
    } finally {
      set({ loading: false })
    }
  },

  async setCredential(profileId: string, secret: string): Promise<void> {
    set({ loading: true, error: undefined })
    try {
      await api().setCredential(profileId, secret)
      set({ notice: '密钥已安全保存', state: await api().getState() })
    } catch (cause) {
      set({ error: userMessage(cause, get().state, profileId) })
    } finally {
      set({ loading: false })
    }
  },

  async testConnection(profileId: string): Promise<HealthResult | undefined> {
    set((current) => {
      const profile = current.state.agents.flatMap((agent) => agent.profiles).find((candidate) => candidate.id === profileId)
      return {
        error: undefined,
        notice: undefined,
        checkingProfileId: profileId,
        state: patchProfile(current.state, profileId, {
          health: 'checking',
          latencyMs: undefined,
          healthMessage: profile?.authKind === 'oauth'
            ? '正在使用本机 OAuth 凭据检查认证接口…'
            : '正在使用当前 Endpoint、模型和凭据发送最小请求…'
        })
      }
    })
    try {
      const result = await api().testConnection(profileId)
      set({
        state: await api().getState(),
        notice: result.state === 'healthy'
          ? `可用性检测通过 · ${result.latencyMs ?? 0} ms`
          : undefined,
        error: result.state === 'healthy' ? undefined : result.message
      })
      return result
    } catch (cause) {
      set({ error: userMessage(cause, get().state, profileId) })
      return undefined
    } finally {
      set((current) => ({ checkingProfileId: current.checkingProfileId === profileId ? undefined : current.checkingProfileId }))
    }
  },

  async loadSnapshots(agent: AgentId): Promise<void> {
    try {
      set({ snapshots: await api().listSnapshots(agent) })
    } catch (cause) {
      set({ error: userMessage(cause, get().state) })
    }
  },

  async restoreSnapshot(agent: AgentId, snapshotId: string): Promise<void> {
    set({ loading: true, error: undefined })
    try {
      await api().restoreSnapshot(agent, snapshotId)
      set({ notice: 'Snapshot restored' })
      await get().refresh()
      await get().loadSnapshots(agent)
    } catch (cause) {
      set({ error: userMessage(cause, get().state) })
    } finally {
      set({ loading: false })
    }
  },

  async launchLogin(agent: AgentId): Promise<void> {
    set({ error: undefined })
    try {
      await api().launchNativeLogin(agent)
      set({ notice: '已打开登录流程；完成授权后可重新检测' })
    } catch (cause) {
      set({ error: userMessage(cause, get().state) })
    }
  },

  async prepareLaunch(profileId: string): Promise<LaunchSpec | undefined> {
    set({ preparingProfileId: profileId, error: undefined })
    try {
      const spec = await api().prepareLaunch(profileId)
      set((current) => ({ launchSpecs: { ...current.launchSpecs, [profileId]: spec } }))
      return spec
    } catch (cause) {
      set({ error: userMessage(cause, get().state, profileId) })
      return undefined
    } finally {
      set((current) => ({ preparingProfileId: current.preparingProfileId === profileId ? undefined : current.preparingProfileId }))
    }
  },

  async launchProfile(profileId: string): Promise<void> {
    set({ runningProfileId: profileId, error: undefined, notice: undefined })
    try {
      const spec = await api().launchProfile(profileId)
      set((current) => ({
        launchSpecs: { ...current.launchSpecs, [profileId]: spec },
        notice: '已在终端中启动 Agent'
      }))
    } catch (cause) {
      set({ error: userMessage(cause, get().state, profileId) })
    } finally {
      set((current) => ({ runningProfileId: current.runningProfileId === profileId ? undefined : current.runningProfileId }))
    }
  },

  selectAgent(agent: AgentId): void {
    set({ selectedAgent: agent })
  },

  subscribeExternal(): () => void {
    return window.paiSwitch?.onChanged((state) => set({ state })) ?? (() => undefined)
  },

  clearError(): void {
    set({ error: undefined })
  },

  clearNotice(): void {
    set({ notice: undefined })
  }
}))

export { AGENT_ORDER }

function userMessage(error: unknown, state: AppState, profileId?: string): string {
  const profile = profileId
    ? state.agents.flatMap((agent) => agent.profiles).find((candidate) => candidate.id === profileId)
    : undefined
  return presentError(error, profile
    ? {
        profileName: profile.name,
        authKind: profile.authKind,
        credentialLabel: profile.credentialGuide?.label
      }
    : undefined)
}

function patchProfile(state: AppState, profileId: string, patch: Partial<AppState['agents'][number]['profiles'][number]>): AppState {
  return {
    agents: state.agents.map((agent) => ({
      ...agent,
      profiles: agent.profiles.map((profile) => profile.id === profileId ? { ...profile, ...patch } : profile)
    }))
  }
}
