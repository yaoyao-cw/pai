import { describe, expect, it } from 'vitest'
import { presentError } from '../src/core/user-errors'

describe('renderer-facing errors', () => {
  it('turns a missing DashScope credential IPC failure into actionable guidance', () => {
    const error = new Error("Error invoking remote method 'agent:prepare-launch': Error: Credential missing for DashScope DeepSeek")

    expect(presentError(error, {
      profileName: 'DashScope DeepSeek',
      authKind: 'api-key',
      credentialLabel: '阿里云百炼 API Key'
    })).toBe('DashScope DeepSeek 缺少阿里云百炼 API Key。请在右侧“凭据”区域粘贴密钥并保存，然后重试。')
  })

  it('removes Electron IPC wrapping from other errors', () => {
    const error = new Error("Error invoking remote method 'agent:launch-profile': Error: No supported terminal emulator was found")

    expect(presentError(error)).toBe('未找到可用的终端程序。请安装 GNOME Terminal、Konsole、WezTerm 或 xterm 后重试。')
  })

  it('explains a revoked OAuth session instead of blaming Mega or an API key', () => {
    const error = new Error("Error invoking remote method 'health:test': Error: Your session has ended. Please log in again. (refresh_token_invalidated)")

    expect(presentError(error, {
      profileName: 'OpenAI Codex Official',
      authKind: 'oauth',
      credentialLabel: 'ChatGPT OAuth'
    })).toContain('OAuth 会话已失效或被吊销')
  })
})
