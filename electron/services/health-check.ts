import { fetch, ProxyAgent } from 'undici'
import type { HealthResult, ProfileSummary } from '../../src/shared'
import type { HealthProbeDefinition, ProfileDefinition } from './profiles'

function oauthAccessToken(secret: string | undefined): string | undefined {
  if (!secret) return undefined
  try {
    const parsed = JSON.parse(secret) as {
      access_token?: string
      tokens?: { access_token?: string }
      claudeAiOauth?: { accessToken?: string }
    }
    return parsed.access_token ?? parsed.tokens?.access_token ?? parsed.claudeAiOauth?.accessToken
  } catch {
    return secret
  }
}

function authHeaders(profile: ProfileSummary, probe: HealthProbeDefinition, secret?: string): Record<string, string> {
  if (!secret || probe.auth === 'none') return {}
  const token = profile.authKind === 'oauth' ? oauthAccessToken(secret) : secret
  if (!token) return {}
  const scheme = probe.auth ?? (profile.agent === 'claude' ? 'x-api-key' : 'bearer')
  return scheme === 'x-api-key' ? { 'x-api-key': token } : { authorization: `Bearer ${token}` }
}

function requestBody(profile: ProfileDefinition, probe: HealthProbeDefinition): string | undefined {
  const model = probe.requestModel ?? profile.model
  if (probe.kind === 'anthropic-messages') {
    if (!model) return undefined
    return JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: 'user', content: '回复 OK' }]
    })
  }
  if (probe.kind === 'openai-responses') {
    if (!model) return undefined
    return JSON.stringify({
      model,
      input: '回复 OK',
      max_output_tokens: 8
    })
  }
  return undefined
}

function providerMessage(text: string, secret?: string): string | undefined {
  if (!text.trim()) return undefined
  let message: string | undefined
  try {
    const parsed = JSON.parse(text) as {
      message?: unknown
      detail?: unknown
      error?: unknown | { message?: unknown }
    }
    if (typeof parsed.error === 'object' && parsed.error && 'message' in parsed.error) {
      const candidate = parsed.error.message
      if (typeof candidate === 'string') message = candidate
    }
    if (!message && typeof parsed.message === 'string') message = parsed.message
    if (!message && typeof parsed.detail === 'string') message = parsed.detail
    if (!message && typeof parsed.error === 'string') message = parsed.error
  } catch {
    message = text
  }
  const normalized = message?.replace(/\s+/g, ' ').trim().slice(0, 240)
  return normalized && secret ? normalized.replaceAll(secret, '<REDACTED>') : normalized
}

function failureMessage(status: number, detail: string | undefined, profile: ProfileSummary): string {
  const providerDetail = detail ? `；服务商返回：${detail}` : ''
  if (status === 401 && profile.authKind === 'oauth' && detail && /token_revoked|refresh_token_invalidated|session has ended|not be refreshed|重新登录|log in again/i.test(detail)) {
    const loginCommand = profile.agent === 'codex' ? 'codex login' : profile.agent === 'claude' ? 'claude auth login' : profile.agent === 'grok' ? 'grok login' : 'Agent 原生登录'
    return `OAuth 会话已失效（HTTP 401）：请重新完成${profile.credentialGuide?.label ?? 'OAuth'}授权。可点击“登录”，或在同一配置目录执行 ${loginCommand}；如仍提示 token revoked，先执行 logout 后再 login。${providerDetail}`
  }
  if (status === 401) return `认证失败（HTTP 401）：密钥无效或已过期${providerDetail}`
  if (status === 403) return `访问被拒绝（HTTP 403）：当前凭据没有该模型或接口权限${providerDetail}`
  if (status === 404) return `接口不存在（HTTP 404）：请检查 Endpoint 路径${providerDetail}`
  if (status === 429) return `请求受限（HTTP 429）：额度不足或请求过于频繁${providerDetail}`
  if (status >= 500) return `服务端错误（HTTP ${status}）：服务商暂时不可用${providerDetail}`
  return detail ? `请求失败（HTTP ${status}）：${detail}` : `请求失败（HTTP ${status}）`
}

function makeResult(profileId: string, state: HealthResult['state'], message: string, started: number, statusCode?: number): HealthResult {
  return {
    profileId,
    state,
    message,
    latencyMs: Math.round(performance.now() - started),
    statusCode,
    checkedAt: new Date().toISOString()
  }
}

export async function testProfileConnection(profile: ProfileDefinition, secret?: string): Promise<HealthResult> {
  const started = performance.now()
  const probe = profile.healthProbe
  if (profile.authKind !== 'none' && !secret) {
    return makeResult(profile.id, 'not-configured', '未执行可用性检测：缺少凭据', started)
  }

  const body = requestBody(profile, probe)
  if ((probe.kind === 'anthropic-messages' || probe.kind === 'openai-responses') && !body) {
    return makeResult(profile.id, 'not-configured', '未执行可用性检测：未配置检测模型', started)
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...authHeaders(profile, probe, secret),
    ...(probe.headers ?? {})
  }
  if (probe.kind === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01'
  if (body) headers['content-type'] = 'application/json'

  const controller = new AbortController()
  const timeoutMs = probe.timeoutMs ?? 8000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let dispatcher: ProxyAgent | undefined
  try {
    if (probe.proxy) dispatcher = new ProxyAgent(probe.proxy)
    const response = await fetch(probe.url, {
      method: probe.method,
      headers,
      body,
      signal: controller.signal,
      dispatcher
    })
    const text = await response.text()
    if (!response.ok) {
      return makeResult(profile.id, 'unhealthy', failureMessage(response.status, providerMessage(text, secret), profile), started, response.status)
    }
    if (body) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown }
        if (parsed.error) return makeResult(profile.id, 'unhealthy', '服务端返回了错误响应', started, response.status)
      } catch {
        return makeResult(profile.id, 'unhealthy', '响应格式异常：期望 JSON 模型响应', started, response.status)
      }
      return makeResult(profile.id, 'healthy', '可用：最小模型请求成功', started, response.status)
    }
    return makeResult(profile.id, 'healthy', '可用：认证接口响应正常', started, response.status)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return makeResult(profile.id, 'unhealthy', `检测超时：${Math.ceil(timeoutMs / 1000)} 秒内未收到响应`, started)
    }
    const message = error instanceof Error ? error.message : String(error)
    return makeResult(profile.id, 'unhealthy', `网络错误：${providerMessage(message, secret) ?? '未知错误'}`, started)
  } finally {
    clearTimeout(timer)
    await dispatcher?.close().catch(() => undefined)
  }
}
