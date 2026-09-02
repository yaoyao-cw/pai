import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LogIn,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SquareTerminal,
  Wifi,
  X
} from 'lucide-react'
import { useAgentStore } from './stores/agent-store'
import type { AgentId, ProfileSummary } from './shared'
import { AGENT_ORDER } from './shared'

const CONFIG_PATH: Record<AgentId, string> = {
  claude: '~/.claude/settings.json',
  codex: '~/.codex/config.toml',
  antigravity: '~/.gemini/antigravity-cli/settings.json',
  grok: '~/.grok/config.toml'
}

function healthLabel(profile: ProfileSummary): string {
  if (profile.health === 'healthy') return profile.latencyMs != null ? `可用 · ${profile.latencyMs} ms` : '可用'
  if (profile.health === 'checking') return '检测中'
  if (profile.health === 'unhealthy') return '不可用'
  if (profile.health === 'not-configured') return '未执行'
  return '未检测'
}

function credentialLabel(profile: ProfileSummary, detailed = false): string {
  const name = profile.credentialGuide?.label ?? (profile.authKind === 'oauth' ? 'OAuth' : 'API Key')
  if (profile.authKind === 'none') return '无需凭据'
  if (profile.credentialStatus === 'configured') return detailed ? `${name} 已配置` : (profile.authKind === 'oauth' ? 'OAuth 就绪' : '密钥已备')
  if (profile.credentialStatus === 'missing') return detailed ? `缺少${name}` : '凭据缺失'
  if (profile.credentialStatus === 'expired') return detailed ? `${name} 已过期` : '凭据过期'
  return detailed ? `${name} 状态无法确认` : '状态未知'
}

function authLabel(profile: ProfileSummary): string {
  return profile.authKind === 'oauth' ? 'OAuth' : profile.authKind === 'api-key' ? 'API key' : '无认证'
}

function credentialReady(profile: ProfileSummary): boolean {
  return profile.authKind === 'none'
    || profile.credentialStatus === 'configured'
    || profile.credentialStatus === 'not-required'
}

function launchBlockedMessage(profile: ProfileSummary): string {
  const credential = profile.credentialGuide?.label ?? (profile.authKind === 'oauth' ? 'OAuth 登录' : 'API Key')
  if (profile.capabilities.supportsNativeLogin) return `请先点击“登录”完成${credential}`
  return `请先在下方保存${credential}`
}

function availabilityDescription(profile: ProfileSummary): string {
  if (profile.authKind === 'oauth') return '使用本机 OAuth 凭据检查对应认证接口；检测结果会说明实际验证范围。'
  return '使用当前 Endpoint、模型和凭据发送最小请求，验证该 Profile 是否可实际使用。'
}

function HealthIndicator({ profile, compact = false }: { profile: ProfileSummary; compact?: boolean }) {
  return (
    <span className={`health-text health-${profile.health}${compact ? ' compact' : ''}`} title={profile.healthMessage}>
      <span className="health-pip" aria-hidden />
      {!compact && healthLabel(profile)}
    </span>
  )
}

export default function App() {
  const {
    state,
    selectedAgent,
    loading,
    error,
    notice,
    snapshots,
    launchSpecs,
    preparingProfileId,
    runningProfileId,
    checkingProfileId,
    refresh,
    switchProfile,
    setCredential,
    testConnection,
    loadSnapshots,
    restoreSnapshot,
    launchLogin,
    prepareLaunch,
    launchProfile,
    selectAgent,
    subscribeExternal,
    clearError,
    clearNotice
  } = useAgentStore()
  const [selectedProfileId, setSelectedProfileId] = useState<string>()
  const [credentialValue, setCredentialValue] = useState('')
  const [revealCredential, setRevealCredential] = useState(false)
  const [copied, setCopied] = useState(false)

  const currentAgent = useMemo(
    () => state.agents.find((agent) => agent.id === selectedAgent),
    [state.agents, selectedAgent]
  )
  const currentProfile = useMemo(
    () => currentAgent?.profiles.find((profile) => profile.id === selectedProfileId)
      ?? currentAgent?.profiles.find((profile) => profile.id === currentAgent.activeProfileId)
      ?? currentAgent?.profiles[0],
    [currentAgent, selectedProfileId]
  )
  const isCredentialReady = currentProfile ? credentialReady(currentProfile) : false
  const launchSpec = currentProfile && isCredentialReady ? launchSpecs[currentProfile.id] : undefined
  const isActive = currentProfile?.id === currentAgent?.activeProfileId
  const canEditCredential = Boolean(currentProfile?.capabilities.supportsCredentialEdit)

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    const initialize = async () => {
      await refresh()
      if (!cancelled) unsubscribe = subscribeExternal()
    }
    void initialize()
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [refresh, subscribeExternal])

  useEffect(() => {
    setSelectedProfileId(undefined)
    setCredentialValue('')
    setRevealCredential(false)
    void loadSnapshots(selectedAgent)
  }, [selectedAgent, loadSnapshots])

  useEffect(() => {
    if (currentProfile && credentialReady(currentProfile)) void prepareLaunch(currentProfile.id)
  }, [currentProfile?.id, currentProfile?.credentialStatus, prepareLaunch])

  async function activate(profile: ProfileSummary): Promise<void> {
    if (profile.id === currentAgent?.activeProfileId) return
    const confirmed = window.confirm(`将 ${profile.name} 设为 ${currentAgent?.label ?? 'Agent'} 的默认订阅方式？`)
    if (!confirmed) return
    const result = await switchProfile(profile.agent, profile.id)
    if (result) await loadSnapshots(profile.agent)
  }

  async function saveCredential(): Promise<void> {
    if (!currentProfile || !credentialValue.trim()) return
    await setCredential(currentProfile.id, credentialValue)
    if (!useAgentStore.getState().error) {
      setCredentialValue('')
      setRevealCredential(false)
      await prepareLaunch(currentProfile.id)
    }
  }

  async function copyCommand(): Promise<void> {
    if (!launchSpec) return
    await navigator.clipboard.writeText(launchSpec.command)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  function selectProfile(profileId: string): void {
    setSelectedProfileId(profileId)
    setCredentialValue('')
  }

  function handleProfileKey(event: KeyboardEvent<HTMLTableRowElement>, profileId: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      selectProfile(profileId)
    }
  }

  function dismissMessages(): void {
    clearError()
    clearNotice()
  }

  const lastUpdated = currentAgent?.updatedAt
    ? new Date(currentAgent.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--:--'

  return (
    <div className="switch-shell">
      <header className="titlebar">
        <div className="title-brand">
          <span className="brand-symbol"><ShieldCheck size={15} /></span>
          <strong>pai-switch</strong>
          <span>本机 Agent 订阅与路由</span>
        </div>
        <div className="title-actions">
          <span><b>{state.agents.length}</b> Agents</span>
          <span className="title-divider" />
          <span>更新于 <b>{lastUpdated}</b></span>
          <button className="icon-control" type="button" title="刷新状态" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw size={14} className={loading ? 'spin' : undefined} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="fleet" aria-label="Agent 列表">
          <div className="fleet-head">
            <p className="kicker">Active profiles</p>
            <p>每个 Agent 保留一个默认订阅方式。</p>
          </div>
          <nav className="agent-slots">
            {AGENT_ORDER.map((agentId) => {
              const agent = state.agents.find((candidate) => candidate.id === agentId)
              if (!agent) return null
              const active = agent.profiles.find((profile) => profile.id === agent.activeProfileId)
              return (
                <button
                  key={agent.id}
                  className={`agent-jack${selectedAgent === agent.id ? ' selected' : ''}`}
                  type="button"
                  onClick={() => selectAgent(agent.id)}
                >
                  <span className={`signal-lamp${active ? ' live' : ''}`} aria-hidden />
                  <span className="jack-copy">
                    <strong>{agent.label}</strong>
                    <em>{active?.name ?? '未配置'}</em>
                    {active && <HealthIndicator profile={active} />}
                  </span>
                </button>
              )
            })}
          </nav>
          <p className="fleet-foot">默认切换只影响之后启动的会话。</p>
        </aside>

        <main className="profile-workbench">
          <div className="profile-head">
            <div>
              <p className="kicker">{currentAgent?.label ?? 'Agent'}</p>
              <h1>订阅方式</h1>
            </div>
            <span className="profile-count">{String(currentAgent?.profiles.length ?? 0).padStart(2, '0')}</span>
          </div>

          {(error || notice) && (
            <div className={`message-bar${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
              <span>{error ?? notice}</span>
              <button type="button" title="关闭消息" onClick={dismissMessages}><X size={14} /></button>
            </div>
          )}

          <div className="profile-table-wrap">
            <table className="profile-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>订阅方式</th>
                  <th>Endpoint</th>
                  <th>认证</th>
                </tr>
              </thead>
              <tbody>
                {currentAgent?.profiles.map((profile) => {
                  const active = profile.id === currentAgent.activeProfileId
                  const selected = profile.id === currentProfile?.id
                  return (
                    <tr
                      key={profile.id}
                      className={`${selected ? 'selected ' : ''}${active ? 'active' : ''}`}
                      tabIndex={0}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => selectProfile(profile.id)}
                      onKeyDown={(event) => handleProfileKey(event, profile.id)}
                    >
                      <td className="status-cell">
                        <span className={`signal-lamp${active ? ' live' : ''}`} aria-hidden />
                        {active && <span className="active-tag">默认</span>}
                      </td>
                      <td>
                        <span className="profile-name"><strong>{profile.name}</strong><small>{profile.description}</small></span>
                      </td>
                      <td><span className="mono cell-end">{profile.endpoint ?? CONFIG_PATH[profile.agent]}</span></td>
                      <td><span className={`credential credential-${profile.credentialStatus}`}>{credentialLabel(profile)}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!currentAgent?.profiles.length && <p className="empty-panel">没有可用的订阅方式。</p>}
          </div>
        </main>

        <aside className="inspector" aria-label="订阅方式详情">
          {currentProfile ? (
            <>
              <div className="inspector-head">
                <div>
                  <p className="kicker">{currentAgent?.label}</p>
                  <h2>{currentProfile.name}</h2>
                </div>
                <span className="auth-chip">{authLabel(currentProfile)}</span>
              </div>
              <div className="profile-flags">
                {isActive ? <span className="active-tag">默认配置</span> : <span className="muted-chip">未设为默认</span>}
                <HealthIndicator profile={currentProfile} />
              </div>
              <p className="inspector-lede">{currentProfile.description}</p>

              <dl className="detail-fields">
                <div><dt>Endpoint</dt><dd className="mono">{currentProfile.endpoint ?? '本机默认'}</dd></div>
                <div><dt>Model</dt><dd>{currentProfile.model ?? 'Agent 默认'}</dd></div>
                {currentProfile.availabilityModel && currentProfile.availabilityModel !== currentProfile.model && (
                  <div><dt>检测 Model</dt><dd>{currentProfile.availabilityModel}</dd></div>
                )}
                <div><dt>凭据</dt><dd className={`credential credential-${currentProfile.credentialStatus}`}>{credentialLabel(currentProfile, true)}</dd></div>
                <div><dt>写入路径</dt><dd className="mono">{CONFIG_PATH[currentProfile.agent]}</dd></div>
              </dl>

              <div className="profile-actions">
                <button
                  className="control primary"
                  type="button"
                  disabled={Boolean(isActive) || loading || !isCredentialReady}
                  title={!isCredentialReady ? launchBlockedMessage(currentProfile) : undefined}
                  onClick={() => void activate(currentProfile)}
                >
                  <Check size={14} />{isActive ? '当前默认' : '设为默认'}
                </button>
                <button
                  className="control"
                  type="button"
                  disabled={loading || !isCredentialReady || checkingProfileId === currentProfile.id}
                  title={!isCredentialReady ? launchBlockedMessage(currentProfile) : availabilityDescription(currentProfile)}
                  onClick={() => void testConnection(currentProfile.id)}
                >
                  <Wifi size={14} />{checkingProfileId === currentProfile.id ? '检测中' : '检测可用性'}
                </button>
                {currentProfile.capabilities.supportsNativeLogin && (
                  <button className="control" type="button" onClick={() => void launchLogin(currentProfile.agent)}>
                    <LogIn size={14} />登录
                  </button>
                )}
              </div>

              <div className={`availability-result availability-${currentProfile.health}`} role="status" aria-live="polite">
                <div>
                  <span>最近检测</span>
                  <strong>{healthLabel(currentProfile)}</strong>
                </div>
                <p>{currentProfile.healthMessage ?? availabilityDescription(currentProfile)}</p>
                {currentProfile.healthCheckedAt && (
                  <small>
                    {new Date(currentProfile.healthCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    {currentProfile.healthStatusCode ? ` · HTTP ${currentProfile.healthStatusCode}` : ''}
                  </small>
                )}
              </div>

              <section className="inspector-block command-block">
                <div className="block-title">
                  <h3>按此配置运行</h3>
                  {launchSpec && <span>{launchSpec.isolation === 'profile' ? '独立配置' : '共享配置'}</span>}
                </div>
                <div className="command-line">
                  <SquareTerminal size={15} />
                  <code>{preparingProfileId === currentProfile.id ? '正在准备命令...' : launchSpec?.command ?? launchBlockedMessage(currentProfile)}</code>
                  <button type="button" title="复制命令" disabled={!launchSpec} onClick={() => void copyCommand()}>
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
                <button
                  className="control run-control"
                  type="button"
                  disabled={!launchSpec || runningProfileId === currentProfile.id}
                  onClick={() => void launchProfile(currentProfile.id)}
                >
                  <Play size={14} />{runningProfileId === currentProfile.id ? '正在启动' : '在终端运行'}
                </button>
              </section>

              <section className="inspector-block">
                <h3>凭据</h3>
                <div className={`credential-guide${isCredentialReady ? '' : ' needs-attention'}`}>
                  <div>
                    <strong>{currentProfile.credentialGuide?.label ?? authLabel(currentProfile)}</strong>
                    <span>{credentialLabel(currentProfile, true)}</span>
                  </div>
                  <p>{currentProfile.credentialGuide?.help ?? (canEditCredential ? '粘贴该服务商分配的 API Key。' : '由 Agent 本机登录管理。')}</p>
                </div>
                {canEditCredential ? (
                  <form className="credential-form" onSubmit={(event) => { event.preventDefault(); void saveCredential() }}>
                    <div className="credential-input">
                      <KeyRound size={14} />
                      <input
                        type={revealCredential ? 'text' : 'password'}
                        autoComplete="new-password"
                        placeholder={`粘贴${currentProfile.credentialGuide?.label ?? 'API Key'}`}
                        value={credentialValue}
                        onChange={(event) => setCredentialValue(event.target.value)}
                      />
                      <button type="button" title={revealCredential ? '隐藏密钥' : '显示密钥'} onClick={() => setRevealCredential((visible) => !visible)}>
                        {revealCredential ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    <button className="control" type="submit" disabled={!credentialValue.trim() || loading}>
                      {currentProfile.credentialStatus === 'configured' ? '更新密钥' : '保存密钥'}
                    </button>
                  </form>
                ) : null}
              </section>

              <section className="inspector-block snapshot-block">
                <div className="block-title"><h3>Snapshots</h3><span>{snapshots.length}</span></div>
                {!snapshots.length && <p className="block-hint">还没有快照。</p>}
                <ul className="snapshot-list">
                  {snapshots.map((snapshot) => (
                    <li key={snapshot.id}>
                      <span><strong>{new Date(snapshot.createdAt).toLocaleString()}</strong><small>{snapshot.fileCount} 个文件</small></span>
                      <button type="button" title="恢复快照" onClick={() => void restoreSnapshot(snapshot.agent, snapshot.id)}><RotateCcw size={14} /></button>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : (
            <p className="empty-panel">请选择一个订阅方式。</p>
          )}
        </aside>
      </div>

      <footer className="statusbar">
        <span><b>默认配置</b> 供普通命令使用</span>
        <span className="status-command">独立命令可同时运行不同订阅方式</span>
      </footer>
    </div>
  )
}
