export interface ErrorProfileContext {
  profileName: string
  authKind: 'oauth' | 'api-key' | 'none'
  credentialLabel?: string
}

function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unwrapElectronError(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

export function presentError(error: unknown, profile?: ErrorProfileContext): string {
  const message = unwrapElectronError(rawMessage(error))

  if (/^Credential missing for /i.test(message) && profile) {
    const credential = profile.credentialLabel ?? (profile.authKind === 'oauth' ? 'OAuth 登录' : 'API Key')
    if (profile.authKind === 'oauth') {
      return `${profile.profileName} 尚未完成${credential}。请点击“登录”并在 Agent 中完成授权，然后重试。`
    }
    return `${profile.profileName} 缺少${credential}。请在右侧“凭据”区域粘贴密钥并保存，然后重试。`
  }

  if (message === 'No supported terminal emulator was found') {
    return '未找到可用的终端程序。请安装 GNOME Terminal、Konsole、WezTerm 或 xterm 后重试。'
  }
  if (message.startsWith('OS credential storage is unavailable')) {
    return '系统密钥环不可用，无法安全保存凭据。请启用 Secret Service/Keyring 后重试。'
  }
  if (message === 'Credential cannot be empty') return '密钥不能为空。'
  if (/token_revoked|refresh_token_invalidated|session has ended|refresh token.*revoked|请重新登录|log in again/i.test(message)) {
    const isCodexOAuth = profile?.authKind === 'oauth'
      && (profile.credentialLabel?.includes('ChatGPT') || profile.profileName.includes('OpenAI') || profile.profileName.includes('Codex'))
    const command = isCodexOAuth ? 'codex login' : '对应 Agent 的原生登录命令'
    return `OAuth 会话已失效或被吊销。请点击“登录”重新授权，或执行 ${command}；如果仍提示 token revoked，请先 logout 再 login。`
  }
  if (message.startsWith('Unable to open a terminal:')) return `无法打开终端。${message.slice('Unable to open a terminal:'.length).trim()}`

  return message || '操作失败，但未返回具体原因。'
}
