import path from 'node:path'
import type { AgentId, AuthKind, CredentialGuide, ProfileCapabilities, ProfileSummary } from '../../src/shared'
import type { HealthProbeDefinition, ProfileDefinition } from '../../src/core/contracts'

export type { HealthProbeDefinition, ProfileDefinition } from '../../src/core/contracts'

const CREDENTIAL_GUIDES: Record<string, CredentialGuide> = {
  'claude-bai': { label: 'B.AI API Key', help: '在 B.AI 控制台创建 API Key，然后粘贴到下方。' },
  'claude-deepseek': { label: '阿里云百炼 API Key', help: '在阿里云百炼控制台创建 API Key。DashScope DeepSeek 与 Qwen 共用这一密钥。' },
  'claude-qwen': { label: '阿里云百炼 API Key', help: '在阿里云百炼控制台创建 API Key。DashScope DeepSeek 与 Qwen 共用这一密钥。' },
  'claude-official': { label: 'Anthropic OAuth', help: '点击上方“登录”，然后在 Claude Code 中完成 Anthropic 账号授权。' },
  'codex-official': { label: 'ChatGPT OAuth', help: '点击上方“登录”，然后在 Codex 中完成 ChatGPT 账号授权。' },
  'codex-official-api': { label: 'OpenAI API Key', help: '在 OpenAI Platform 创建 API Key，然后粘贴到下方。这不是 ChatGPT 登录凭据。' },
  'codex-mega': { label: 'Mega API Key', help: '使用 Mega 服务商分配的 API Key。' },
  'codex-custom': { label: 'AnyRouter API Key', help: '使用 AnyRouter 服务商分配的 API Key。' },
  'codex-sharedchat': { label: 'SharedChat API Key', help: '使用 SharedChat 服务商分配的 API Key。' },
  'codex-hotaru': { label: 'Hotaru API Key', help: '使用 Hotaru 服务商分配的 API Key。' },
  'codex-wzw': { label: 'WZW API Key', help: '使用 WZW 服务商分配的 API Key。' },
  'antigravity-google': { label: 'Google OAuth', help: '点击上方“登录”，然后在 Antigravity CLI 中完成 Google 账号授权。' },
  'grok-official': { label: 'Grok OAuth', help: '点击上方“登录”，然后在 Grok CLI 中完成账号授权。' },
  'grok-mega': { label: 'Mega API Key', help: '使用 Mega 服务商分配的 API Key，用于访问 Grok 模型。' }
}

type ProfileSeed = Omit<ProfileDefinition, 'health' | 'credentialStatus'> & { authKind: AuthKind }

const AVAILABILITY_MODEL_OVERRIDES: Record<string, string> = {
  // These names are valid Claude CLI aliases, but DashScope expects the API
  // model ID without Claude's local context-window suffix.
  'claude-deepseek': 'deepseek-v4-pro',
  'claude-qwen': 'qwen3.8-max'
}

function availabilityProbe(definition: ProfileSeed): HealthProbeDefinition {
  const current = definition.healthProbe
  if (definition.id === 'claude-bai' || definition.id === 'claude-deepseek' || definition.id === 'claude-qwen') {
    return {
      ...current,
      url: `${definition.endpoint!.replace(/\/$/, '')}/v1/messages`,
      method: 'POST',
      kind: 'anthropic-messages',
      requestModel: AVAILABILITY_MODEL_OVERRIDES[definition.id] ?? definition.model,
      auth: 'bearer'
    }
  }
  if ((definition.agent === 'codex' && definition.id !== 'codex-official') || definition.id === 'grok-mega') {
    return {
      ...current,
      url: `${definition.endpoint!.replace(/\/$/, '')}/responses`,
      method: 'POST',
      kind: 'openai-responses',
      auth: 'bearer'
    }
  }
  return { ...current, kind: 'authenticated-get', auth: definition.authKind === 'none' ? 'none' : 'bearer' }
}

function profile(definition: ProfileSeed): ProfileDefinition {
  const resolved = {
    ...definition,
    model: definition.model ?? (definition.id === 'codex-official-api' ? 'gpt-5.6-sol' : undefined)
  }
  return {
    ...resolved,
    healthProbe: availabilityProbe(resolved),
    credentialGuide: CREDENTIAL_GUIDES[definition.id],
    health: 'unknown',
    credentialStatus: definition.authKind === 'none' ? 'not-required' : 'unknown'
  }
}

export function getProfileDefinitions(homeDir: string): ProfileDefinition[] {
  const claudeDir = path.join(homeDir, '.claude')
  const codexDir = path.join(homeDir, '.codex')
  const geminiDir = path.join(homeDir, '.gemini')
  const grokDir = path.join(homeDir, '.grok')
  const commonClaude: ProfileCapabilities = { supportsModelTiers: true, supportsProxy: true, supportsCredentialEdit: true }
  const commonCodex: ProfileCapabilities = { supportsReasoningEffort: true }

  return [
    profile({ id: 'claude-bai', agent: 'claude', name: 'B.AI', description: 'Aggregated Claude-compatible route', authKind: 'api-key', endpoint: 'https://api.b.ai', model: 'deepseek-v4-flash', credentialRef: 'claude:bai', credentialPath: path.join(claudeDir, 'auth.json.key.bai'), configPath: path.join(claudeDir, 'settings.json'), envPath: path.join(claudeDir, 'current_env.sh'), statePath: path.join(claudeDir, '.current_provider'), capabilities: commonClaude, healthProbe: { url: 'https://api.b.ai/v1/models', method: 'GET', proxy: 'http://127.0.0.1:7897' } }),
    profile({ id: 'claude-deepseek', agent: 'claude', name: 'DashScope DeepSeek', description: 'DeepSeek through DashScope', authKind: 'api-key', endpoint: 'https://dashscope.aliyuncs.com/apps/anthropic', model: 'deepseek-v4-pro[1m]', credentialRef: 'claude:dashscope', credentialPath: path.join(claudeDir, 'auth.json.key.dashscope'), configPath: path.join(claudeDir, 'settings.json'), envPath: path.join(claudeDir, 'current_env.sh'), statePath: path.join(claudeDir, '.current_provider'), capabilities: commonClaude, healthProbe: { url: 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages', method: 'POST' } }),
    profile({ id: 'claude-qwen', agent: 'claude', name: 'DashScope Qwen', description: 'Qwen through DashScope', authKind: 'api-key', endpoint: 'https://dashscope.aliyuncs.com/apps/anthropic', model: 'qwen3.8-max[1m]', credentialRef: 'claude:dashscope', credentialPath: path.join(claudeDir, 'auth.json.key.dashscope'), configPath: path.join(claudeDir, 'settings.json'), envPath: path.join(claudeDir, 'current_env.sh'), statePath: path.join(claudeDir, '.current_provider'), capabilities: commonClaude, healthProbe: { url: 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages', method: 'POST' } }),
    profile({ id: 'claude-official', agent: 'claude', name: 'Anthropic Official', description: 'Native Anthropic account', authKind: 'oauth', endpoint: 'https://api.anthropic.com', oauthPath: path.join(claudeDir, '.credentials.json'), configPath: path.join(claudeDir, 'settings.json'), envPath: path.join(claudeDir, 'current_env.sh'), statePath: path.join(claudeDir, '.current_provider'), capabilities: { supportsNativeLogin: true }, healthProbe: { url: 'https://api.anthropic.com', method: 'GET' } }),

    profile({ id: 'codex-official', agent: 'codex', name: 'OpenAI Account', description: 'Native ChatGPT OAuth', authKind: 'oauth', endpoint: 'https://api.openai.com/v1', credentialRef: 'codex:oauth', oauthPath: path.join(codexDir, 'auth.json.oauth'), configPath: path.join(codexDir, 'config.toml'), statePath: path.join(codexDir, '.current_provider'), capabilities: { ...commonCodex, supportsNativeLogin: true }, healthProbe: { url: 'https://api.openai.com/v1/models', method: 'GET' } }),
    profile({ id: 'codex-official-api', agent: 'codex', name: 'OpenAI API', description: 'OpenAI API key route', authKind: 'api-key', endpoint: 'https://api.openai.com/v1', credentialRef: 'codex:official-api', credentialPath: path.join(codexDir, 'auth.json.key.official-api'), configPath: path.join(codexDir, 'config.toml'), statePath: path.join(codexDir, '.current_provider'), capabilities: { ...commonCodex, supportsCredentialEdit: true }, healthProbe: { url: 'https://api.openai.com/v1/models', method: 'GET' } }),
    profile({ id: 'codex-mega', agent: 'codex', name: 'Mega API', description: 'Responses-compatible Mega route', authKind: 'api-key', endpoint: 'https://mega-api.i-tetris.com/v1', model: 'gpt-5.6-sol', credentialRef: 'codex:mega', credentialPath: path.join(codexDir, 'auth.json.key.mega'), configPath: path.join(codexDir, 'config.toml'), statePath: path.join(codexDir, '.current_provider'), capabilities: { ...commonCodex, supportsCredentialEdit: true }, healthProbe: { url: 'https://mega-api.i-tetris.com/v1/models', method: 'GET' } }),
    profile({ id: 'codex-custom', agent: 'codex', name: 'AnyRouter', description: 'Custom OpenAI-compatible route', authKind: 'api-key', endpoint: 'https://anyrouter.top/v1', model: 'gpt-5.6-sol', credentialRef: 'codex:custom', credentialPath: path.join(codexDir, 'auth.json.key.custom'), configPath: path.join(codexDir, 'config.toml'), statePath: path.join(codexDir, '.current_provider'), capabilities: { ...commonCodex, supportsCredentialEdit: true }, healthProbe: { url: 'https://anyrouter.top/v1/models', method: 'GET' } }),
    profile({ id: 'codex-sharedchat', agent: 'codex', name: 'SharedChat', description: 'SharedChat Codex route', authKind: 'api-key', endpoint: 'https://new.sharedchat.cc/codex', model: 'gpt-5.6-sol', credentialRef: 'codex:sharedchat', credentialPath: path.join(codexDir, 'auth.json.key.sharedchat'), configPath: path.join(codexDir, 'config.toml'), statePath: path.join(codexDir, '.current_provider'), capabilities: { ...commonCodex, supportsCredentialEdit: true }, healthProbe: { url: 'https://new.sharedchat.cc/codex/models', method: 'GET' } }),
    profile({ id: 'codex-hotaru', agent: 'codex', name: 'Hotaru API', description: 'Hotaru OpenAI-compatible route', authKind: 'api-key', endpoint: 'https://hotaruapi.com/v1', model: 'gpt-5.6-sol', credentialRef: 'codex:hotaru', credentialPath: path.join(codexDir, 'auth.json.key.hotaru'), configPath: path.join(codexDir, 'config.toml'), statePath: path.join(codexDir, '.current_provider'), capabilities: { ...commonCodex, supportsCredentialEdit: true }, healthProbe: { url: 'https://hotaruapi.com/v1/models', method: 'GET' } }),
    profile({ id: 'codex-wzw', agent: 'codex', name: 'WZW API', description: 'WZW OpenAI-compatible route', authKind: 'api-key', endpoint: 'https://wzw.pp.ua/v1', model: 'gpt-5.6-sol', credentialRef: 'codex:wzw', credentialPath: path.join(codexDir, 'auth.json.key.wzw'), configPath: path.join(codexDir, 'config.toml'), statePath: path.join(codexDir, '.current_provider'), capabilities: { ...commonCodex, supportsCredentialEdit: true }, healthProbe: { url: 'https://wzw.pp.ua/v1/models', method: 'GET' } }),

    profile({ id: 'antigravity-google', agent: 'antigravity', name: 'Google Account', description: 'Native Antigravity Google OAuth', authKind: 'oauth', endpoint: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-pro', credentialRef: 'antigravity:google', oauthPath: path.join(geminiDir, 'oauth_creds.json'), configPath: path.join(geminiDir, 'antigravity-cli', 'settings.json'), capabilities: { supportsNativeLogin: true }, healthProbe: { url: 'https://generativelanguage.googleapis.com/v1beta/models', method: 'GET' } }),

    profile({ id: 'grok-official', agent: 'grok', name: 'Grok Official', description: 'Native Grok.com OAuth', authKind: 'oauth', endpoint: 'https://grok.com', credentialRef: 'grok:oauth', oauthPath: path.join(grokDir, 'auth.json.oauth'), configPath: path.join(grokDir, 'config.toml'), statePath: path.join(grokDir, '.current_provider'), capabilities: { supportsNativeLogin: true, supportsReasoningEffort: true }, healthProbe: { url: 'https://grok.com', method: 'GET' } }),
    profile({ id: 'grok-mega', agent: 'grok', name: 'Grok via Mega', description: 'Grok models through Mega API', authKind: 'api-key', endpoint: 'https://mega-api.i-tetris.com/v1', model: 'grok-4.6', credentialRef: 'grok:mega', credentialPath: path.join(grokDir, 'auth.json.key.mega'), configPath: path.join(grokDir, 'config.toml'), statePath: path.join(grokDir, '.current_provider'), capabilities: { supportsCredentialEdit: true, supportsReasoningEffort: true }, healthProbe: { url: 'https://mega-api.i-tetris.com/v1/models', method: 'GET' } })
  ]
}

export function getAgentLabel(agent: AgentId): string {
  return { claude: 'Claude Code', codex: 'OpenAI Codex', antigravity: 'Antigravity CLI', grok: 'Grok' }[agent]
}
