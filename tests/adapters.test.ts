import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { applyMutation, formatJson } from '../electron/services/file-utils'
import { AntigravityAdapter, ClaudeAdapter, CodexAdapter, GrokAdapter } from '../electron/services/adapters'
import { CredentialVault, type SafeStorageLike } from '../electron/services/credential-vault'
import { getProfileDefinitions } from '../electron/services/profiles'
import { testProfileConnection } from '../electron/services/health-check'
import { SnapshotStore } from '../electron/services/snapshot-store'
import { AgentManager, nativeLoginHomeAssignment } from '../electron/services/agent-manager'

class MemorySafeStorage implements SafeStorageLike {
  isEncryptionAvailable(): boolean { return true }
  encryptString(value: string): Buffer { return Buffer.from(value, 'utf8') }
  decryptString(value: Buffer): string { return value.toString('utf8') }
}

const tempDirs: string[] = []

async function fixture(): Promise<{ home: string; appData: string; vault: CredentialVault }> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pai-switch-home-'))
  const appData = await mkdtemp(path.join(os.tmpdir(), 'pai-switch-data-'))
  tempDirs.push(home, appData)
  const vault = new CredentialVault(path.join(appData, 'vault.json'), new MemorySafeStorage())
  await mkdir(path.join(home, '.claude'), { recursive: true })
  await mkdir(path.join(home, '.codex'), { recursive: true })
  await mkdir(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  await mkdir(path.join(home, '.grok'), { recursive: true })
  return { home, appData, vault }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('metadata-driven Agent adapters', () => {
  it('exposes profiles for all supported Agents', async () => {
    const { home, vault } = await fixture()
    const adapters = [new ClaudeAdapter({ homeDir: home, vault }), new CodexAdapter({ homeDir: home, vault }), new AntigravityAdapter({ homeDir: home, vault }), new GrokAdapter({ homeDir: home, vault })]
    expect(adapters.map((adapter) => [adapter.id, adapter.getProfiles().length])).toEqual([
      ['claude', 4], ['codex', 7], ['antigravity', 1], ['grok', 2]
    ])
    expect(adapters[0].loginCommand()).toEqual({ command: 'claude', args: ['auth', 'login'] })
    expect(adapters[2].loginCommand()).toEqual({ command: 'agy', args: [] })
  })

  it('activates Claude routes while preserving unmanaged settings', async () => {
    const { home, vault } = await fixture()
    await vault.set('claude:bai', '  sk-bai-test  ')
    await writeFile(path.join(home, '.claude', 'settings.json'), formatJson({ env: { EDITOR: 'vim', ANTHROPIC_API_KEY: 'old' }, permissions: { allow: ['Read'] } }))
    const adapter = new ClaudeAdapter({ homeDir: home, vault })
    const prepared = await adapter.prepareActivation('claude-bai')
    for (const mutation of prepared.mutations) await applyMutation(mutation)
    const settings = JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8')) as { env: Record<string, string>; permissions: unknown; model: string }
    expect(settings.permissions).toEqual({ allow: ['Read'] })
    expect(settings.env.EDITOR).toBe('vim')
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-bai-test')
    expect(settings.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(settings.env.HTTP_PROXY).toBe('http://127.0.0.1:7897')
    expect(settings.model).toBe('deepseek-v4-flash')
    expect(await readFile(path.join(home, '.claude', '.current_provider'), 'utf8')).toBe('bai\n')
  })

  it('activates Codex Mega with an independent key file and auth command', async () => {
    const { home, vault } = await fixture()
    await vault.set('codex:mega', 'sk-mega-test')
    await writeFile(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.4"\n[projects.demo]\ntrust_level = "trusted"\n[model_providers.mega]\nrequires_openai_auth = true\n[model_providers.mega.auth]\ncommand = "/usr/bin/jq"\n[model_providers.hotaru]\nrequires_openai_auth = true\n[model_providers.hotaru.auth]\ncommand = "/usr/bin/jq"\n')
    const adapter = new CodexAdapter({ homeDir: home, vault })
    const prepared = await adapter.prepareActivation('codex-mega')
    for (const mutation of prepared.mutations) await applyMutation(mutation)
    const config = parseToml(await readFile(path.join(home, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>
    expect(config.model_provider).toBe('mega')
    expect(config.model).toBe('gpt-5.4')
    expect((config.projects as Record<string, unknown>).demo).toEqual({ trust_level: 'trusted' })
    expect(await readFile(path.join(home, '.codex', 'auth.json'), 'utf8').catch(() => undefined)).toBeUndefined()
    expect(JSON.parse(await readFile(path.join(home, '.codex', 'auth.json.key.mega'), 'utf8'))).toEqual({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-mega-test' })
    const modelProviders = config.model_providers as Record<string, any>
    expect(modelProviders.mega.auth).toMatchObject({
      command: '/usr/bin/jq',
      args: ['-r', '.OPENAI_API_KEY', path.join(home, '.codex', 'auth.json.key.mega')]
    })
    // Codex rejects any provider that combines `auth` with
    // `requires_openai_auth`, including an explicit `false` value.
    expect(modelProviders.mega.requires_openai_auth).toBeUndefined()
    expect(modelProviders.hotaru.requires_openai_auth).toBeUndefined()
  })

  it('reads native JSON key files when the app vault has no entry', async () => {
    const { home, vault } = await fixture()
    await writeFile(path.join(home, '.codex', 'auth.json.key.mega'), formatJson({ auth_mode: 'apikey', OPENAI_API_KEY: 'native-codex-key' }))
    await writeFile(path.join(home, '.codex', 'auth.json.key.custom'), formatJson({ auth_mode: 'apikey', OPENAI_API_KEY: 'native-custom-key' }))
    await writeFile(path.join(home, '.grok', 'auth.json.key.mega'), formatJson({ auth_mode: 'apikey', XAI_API_KEY: 'native-grok-key' }))
    const codex = new CodexAdapter({ homeDir: home, vault })
    const grok = new GrokAdapter({ homeDir: home, vault })
    expect(await codex.getSecret('codex-mega')).toBe('native-codex-key')
    expect(await codex.getSecret('codex-custom')).toBe('native-custom-key')
    expect(await grok.getSecret('grok-mega')).toBe('native-grok-key')
  })

  it('recognizes native OAuth files without requiring an API key field', async () => {
    const { home, vault } = await fixture()
    await writeFile(path.join(home, '.claude', '.credentials.json'), formatJson({ claudeAiOauth: { accessToken: 'oauth-token' } }))
    await writeFile(path.join(home, '.codex', 'auth.json.oauth'), formatJson({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: 'oauth-token' } }))
    await writeFile(path.join(home, '.grok', 'auth.json.oauth'), formatJson({ auth_mode: 'oauth', access_token: 'oauth-token' }))

    const claude = await new ClaudeAdapter({ homeDir: home, vault }).inspect('claude-official')
    const codex = await new CodexAdapter({ homeDir: home, vault }).inspect('codex-official')
    const grok = await new GrokAdapter({ homeDir: home, vault }).inspect('grok-official')

    expect(claude.profiles.find((profile) => profile.id === 'claude-official')?.credentialStatus).toBe('configured')
    expect(codex.profiles.find((profile) => profile.id === 'codex-official')?.credentialStatus).toBe('configured')
    expect(grok.profiles.find((profile) => profile.id === 'grok-official')?.credentialStatus).toBe('configured')
  })

  it('uses the newest native Codex OAuth file after login instead of the archived copy', async () => {
    const { home, vault } = await fixture()
    await vault.set('codex:oauth', formatJson({ auth_mode: 'chatgpt', tokens: { access_token: 'stale-vault-token' } }))
    await writeFile(path.join(home, '.codex', 'auth.json.oauth'), formatJson({ auth_mode: 'chatgpt', tokens: { access_token: 'stale-token' } }))
    await writeFile(path.join(home, '.codex', 'auth.json'), formatJson({ auth_mode: 'chatgpt', tokens: { access_token: 'fresh-token' } }))

    const codex = new CodexAdapter({ homeDir: home, vault })

    expect(await codex.getSecret('codex-official')).toContain('fresh-token')
    expect((await codex.inspect()).profiles.find((profile) => profile.id === 'codex-official')?.credentialStatus).toBe('configured')
  })

  it('does not treat an API-key auth file as Codex OAuth', async () => {
    const { home, vault } = await fixture()
    await writeFile(path.join(home, '.codex', 'auth.json'), formatJson({ auth_mode: 'apikey', OPENAI_API_KEY: 'mega-key' }))
    await writeFile(path.join(home, '.codex', 'auth.json.oauth'), formatJson({ auth_mode: 'chatgpt', tokens: { access_token: 'archived-oauth' } }))

    const codex = new CodexAdapter({ homeDir: home, vault })

    expect(await codex.getSecret('codex-official')).toContain('archived-oauth')
  })

  it('activates Antigravity and Grok profiles using their native files', async () => {
    const { home, vault } = await fixture()
    await writeFile(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), formatJson({ theme: 'dark' }))
    const agy = new AntigravityAdapter({ homeDir: home, vault })
    const agyPrepared = await agy.prepareActivation('antigravity-google')
    for (const mutation of agyPrepared.mutations) await applyMutation(mutation)
    expect(JSON.parse(await readFile(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'))).toMatchObject({ theme: 'dark', model: 'gemini-2.5-pro' })

    await vault.set('grok:mega', 'xai-mega-test')
    await writeFile(path.join(home, '.grok', 'config.toml'), '[models]\ndefault = "grok-4.5"\n')
    const grok = new GrokAdapter({ homeDir: home, vault })
    const grokPrepared = await grok.prepareActivation('grok-mega')
    for (const mutation of grokPrepared.mutations) await applyMutation(mutation)
    const grokConfig = parseToml(await readFile(path.join(home, '.grok', 'config.toml'), 'utf8')) as Record<string, any>
    expect(grokConfig.endpoints.models_base_url).toBe('https://mega-api.i-tetris.com/v1')
    expect(grokConfig.models.default).toBe('grok-4.6')
    expect(grokConfig.model['grok-4.6'].api_key).toBe('xai-mega-test')
  })

  it('rejects malformed native configuration before writing', async () => {
    const { home, vault } = await fixture()
    await writeFile(path.join(home, '.claude', 'settings.json'), '{broken')
    const adapter = new ClaudeAdapter({ homeDir: home, vault })
    await expect(adapter.prepareActivation('claude-official')).rejects.toThrow('Invalid Claude settings JSON')
  })

  it('does not expose credentials in renderer-facing status', async () => {
    const { home, vault } = await fixture()
    await vault.set('claude:bai', 'super-secret')
    const status = await new ClaudeAdapter({ homeDir: home, vault }).inspect('claude-bai')
    expect(JSON.stringify(status)).not.toContain('super-secret')
    expect(status.profiles.find((profile) => profile.id === 'claude-bai')?.credentialStatus).toBe('configured')
  })

  it('keeps the profile definition paths rooted in the selected home', async () => {
    const home = '/tmp/test-home'
    const definitions = getProfileDefinitions(home)
    expect(definitions.find((profile) => profile.id === 'antigravity-google')?.configPath).toBe('/tmp/test-home/.gemini/antigravity-cli/settings.json')
    expect(definitions.find((profile) => profile.id === 'grok-mega')?.credentialPath).toBe('/tmp/test-home/.grok/auth.json.key.mega')
  })

  it('restores a snapshot including files that were created after capture', async () => {
    const { home, appData, vault } = await fixture()
    const target = path.join(home, '.claude', 'settings.json')
    const createdLater = path.join(home, '.claude', 'new-file')
    await writeFile(target, 'before')
    await vault.set('claude:bai', 'before-secret')
    const snapshots = new SnapshotStore(appData)
    const snapshot = await snapshots.create('claude', [target, createdLater, vault.storagePath], 'claude-official')
    await writeFile(target, 'after')
    await writeFile(createdLater, 'unexpected')
    await vault.set('claude:bai', 'after-secret')
    await snapshots.restore('claude', snapshot.id)
    await vault.reload()
    expect(await readFile(target, 'utf8')).toBe('before')
    expect(await vault.get('claude:bai')).toBe('before-secret')
    await expect(readFile(createdLater, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports healthy and timed-out local health probes', async () => {
    const server = createServer((_request, response) => { response.statusCode = 200; response.end('{}') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a port')
    const profile = {
      ...getProfileDefinitions('/tmp/test-home').find((candidate) => candidate.id === 'grok-mega')!,
      healthProbe: {
        url: `http://127.0.0.1:${address.port}`,
        method: 'GET' as const,
        kind: 'authenticated-get' as const,
        auth: 'bearer' as const,
        timeoutMs: 500
      }
    }
    await expect(testProfileConnection(profile, 'test-key')).resolves.toMatchObject({ state: 'healthy', statusCode: 200 })
    server.close()

    const timeoutServer = createServer(() => undefined)
    await new Promise<void>((resolve) => timeoutServer.listen(0, '127.0.0.1', () => resolve()))
    const timeoutAddress = timeoutServer.address()
    if (!timeoutAddress || typeof timeoutAddress === 'string') throw new Error('Timeout server did not expose a port')
    const timeoutProfile = { ...profile, healthProbe: { ...profile.healthProbe, url: `http://127.0.0.1:${timeoutAddress.port}`, timeoutMs: 20 } }
    await expect(testProfileConnection(timeoutProfile, 'test-key')).resolves.toMatchObject({
      state: 'unhealthy',
      message: '检测超时：1 秒内未收到响应'
    })
    timeoutServer.close()
  })

  it('checks DashScope usability with the configured key, model, and message payload', async () => {
    const { home, vault } = await fixture()
    let received: { method?: string; authorization?: string; model?: unknown; messages?: unknown } = {}
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      received = {
        method: request.method,
        authorization: request.headers.authorization,
        model: payload.model,
        messages: payload.messages
      }
      const usable = request.method === 'POST'
        && request.headers.authorization === 'Bearer test-dashscope-key'
        // DashScope accepts the API model ID without Claude's local context-window suffix.
        && payload.model === 'deepseek-v4-pro'
        && Array.isArray(payload.messages)
      response.statusCode = usable ? 200 : 400
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(usable
        ? { id: 'msg_test', content: [{ type: 'text', text: 'ok' }] }
        : { error: { message: 'invalid availability probe' } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a port')

    const definition = getProfileDefinitions(home).find((candidate) => candidate.id === 'claude-deepseek')!
    expect(definition.model).toBe('deepseek-v4-pro[1m]')
    expect(definition.healthProbe.requestModel).toBe('deepseek-v4-pro')
    expect(getProfileDefinitions(home).find((candidate) => candidate.id === 'claude-qwen')?.healthProbe.requestModel).toBe('qwen3.8-max')
    const summary = await new ClaudeAdapter({ homeDir: home, vault }).inspect('claude-deepseek')
    expect(summary.profiles.find((candidate) => candidate.id === 'claude-deepseek')?.availabilityModel).toBe('deepseek-v4-pro')
    const profile = {
      ...definition,
      healthProbe: { ...definition.healthProbe, url: `http://127.0.0.1:${address.port}`, timeoutMs: 500 }
    }
    const result = await testProfileConnection(profile, 'test-dashscope-key')

    expect(result).toMatchObject({ state: 'healthy', statusCode: 200 })
    expect(received).toMatchObject({
      method: 'POST',
      authorization: 'Bearer test-dashscope-key',
      model: 'deepseek-v4-pro'
    })
    expect(received.messages).toEqual([{ role: 'user', content: '回复 OK' }])
    server.close()
  })

  it('checks an OpenAI Responses profile with its configured key and model', async () => {
    let received: { method?: string; authorization?: string; model?: unknown; input?: unknown; maxOutputTokens?: unknown } = {}
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      received = {
        method: request.method,
        authorization: request.headers.authorization,
        model: payload.model,
        input: payload.input,
        maxOutputTokens: payload.max_output_tokens
      }
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ id: 'resp_test', output: [] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a port')

    const definition = getProfileDefinitions('/tmp/test-home').find((candidate) => candidate.id === 'codex-mega')!
    const profile = {
      ...definition,
      healthProbe: { ...definition.healthProbe, url: `http://127.0.0.1:${address.port}`, timeoutMs: 500 }
    }
    const result = await testProfileConnection(profile, 'test-mega-key')

    expect(result).toMatchObject({ state: 'healthy', statusCode: 200, message: '可用：最小模型请求成功' })
    expect(received).toEqual({
      method: 'POST',
      authorization: 'Bearer test-mega-key',
      model: 'gpt-5.6-sol',
      input: '回复 OK',
      maxOutputTokens: 8
    })
    server.close()
  })

  it.each([
    [401, '认证失败'],
    [403, '访问被拒绝'],
    [429, '请求受限']
  ])('reports an actionable provider error for HTTP %i', async (statusCode, category) => {
    const server = createServer((_request, response) => {
      response.statusCode = statusCode
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: { message: `provider rejected test-secret at ${statusCode}` } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a port')

    const definition = getProfileDefinitions('/tmp/test-home').find((candidate) => candidate.id === 'codex-mega')!
    const profile = {
      ...definition,
      healthProbe: { ...definition.healthProbe, url: `http://127.0.0.1:${address.port}`, timeoutMs: 500 }
    }
    const result = await testProfileConnection(profile, 'test-secret')

    expect(result).toMatchObject({ state: 'unhealthy', statusCode })
    expect(result.message).toContain(category)
    expect(result.message).toContain('服务商返回')
    expect(result.message).toContain('<REDACTED>')
    expect(result.message).not.toContain('test-secret')
    server.close()
  })

  it('switches through the manager and follows CLI state changes', async () => {
    const { home, appData, vault } = await fixture()
    await vault.set('claude:bai', 'manager-key')
    await writeFile(path.join(home, '.claude', 'settings.json'), formatJson({ env: { EDITOR: 'vim' } }))
    const manager = new AgentManager(home, appData, vault)
    await manager.initialize()
    const result = await manager.switchProfile('claude', 'claude-bai')
    expect(result.changedFiles).toEqual(expect.arrayContaining(['settings.json', 'current_env.sh', '.current_provider', 'active-profiles.json']))
    expect((await manager.getState()).agents.find((agent) => agent.id === 'claude')?.activeProfileId).toBe('claude-bai')
    expect((await manager.listSnapshots('claude')).length).toBe(1)

    await writeFile(path.join(home, '.claude', '.current_provider'), 'deepseek\n')
    expect((await manager.getState()).agents.find((agent) => agent.id === 'claude')?.activeProfileId).toBe('claude-deepseek')
    manager.dispose()
  })

  it('keeps native login scoped to pai-switch homes instead of inherited agent homes', () => {
    const home = '/tmp/pai-switch-login-home'
    expect(nativeLoginHomeAssignment('codex', home)).toBe("CODEX_HOME='/tmp/pai-switch-login-home/.codex'")
    expect(nativeLoginHomeAssignment('grok', home)).toBe("GROK_HOME='/tmp/pai-switch-login-home/.grok'")
    expect(nativeLoginHomeAssignment('claude', home)).toBe("CLAUDE_CONFIG_DIR='/tmp/pai-switch-login-home/.claude'")
    expect(nativeLoginHomeAssignment('antigravity', home)).toBeUndefined()
  })

  it('does not use inherited CODEX_HOME when switching the desktop-managed config', async () => {
    const { home, appData, vault } = await fixture()
    await vault.set('codex:mega', 'desktop-mega-key')
    const inherited = await mkdtemp(path.join(os.tmpdir(), 'pai-switch-inherited-codex-'))
    tempDirs.push(inherited)
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = inherited
    try {
      const manager = new AgentManager(home, appData, vault)
      await manager.initialize()
      await manager.switchProfile('codex', 'codex-mega')
      expect(await readFile(path.join(home, '.codex', 'config.toml'), 'utf8')).toContain('model_provider = "mega"')
      await expect(readFile(path.join(inherited, 'config.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      manager.dispose()
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
    }
  })

  it('keeps Codex official OAuth auth.json intact when switching the default to Mega', async () => {
    const { home, appData, vault } = await fixture()
    await vault.set('codex:mega', 'mega-switch-key')
    await writeFile(path.join(home, '.codex', 'auth.json'), formatJson({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'official-oauth-token' }
    }))
    await writeFile(path.join(home, '.codex', 'config.toml'), 'model_provider = "official"\n')
    await writeFile(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=<existing-shell-value>\n')

    const manager = new AgentManager(home, appData, vault)
    await manager.initialize()
    await manager.switchProfile('codex', 'codex-mega')

    expect(JSON.parse(await readFile(path.join(home, '.codex', 'auth.json'), 'utf8'))).toEqual({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'official-oauth-token' }
    })
    const config = parseToml(await readFile(path.join(home, '.codex', 'config.toml'), 'utf8')) as Record<string, any>
    expect(config.model_provider).toBe('mega')
    expect(config.model_providers.mega.auth).toMatchObject({
      command: '/usr/bin/jq',
      args: ['-r', '.OPENAI_API_KEY', path.join(home, '.codex', 'auth.json.key.mega')]
    })
    expect(await readFile(path.join(home, '.codex', '.env'), 'utf8')).toBe('OPENAI_API_KEY=<existing-shell-value>\n')
    manager.dispose()
  })

  it('uses Codex built-in openai provider for the Official OAuth route', async () => {
    const { home, vault } = await fixture()
    await writeFile(path.join(home, '.codex', 'auth.json'), formatJson({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'official-oauth-token' }
    }))
    await writeFile(path.join(home, '.codex', 'config.toml'), [
      'model_provider = "openai"',
      'model = "gpt-5.6-sol"',
      '',
      '[model_providers.official]',
      'name = "official"',
      'base_url = "https://api.openai.com/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      'auth_type = "login"',
      'model = "gpt-5.6-sol"',
      ''
    ].join('\n'))
    await writeFile(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=stale-mega-key\nCODEX_TEST=1\n')

    const prepared = await new CodexAdapter({ homeDir: home, vault }).prepareActivation('codex-official')
    const configMutation = prepared.mutations.find((mutation) => mutation.path.endsWith('/config.toml'))
    expect(configMutation?.content).toBeDefined()
    const config = parseToml(configMutation!.content!) as Record<string, any>

    expect(config.model_provider).toBe('openai')
    // The built-in `openai` provider owns the ChatGPT OAuth transport. The
    // adapter must not synthesize a custom `official` provider for it.
    expect(config.model_providers.official).toBeUndefined()
    const envMutation = prepared.mutations.find((mutation) => mutation.path.endsWith('/.env'))
    expect(envMutation?.content).toBe('CODEX_TEST=1\n')
  })

  it('repairs managed Codex auth paths inside the selected home', async () => {
    const { home, vault } = await fixture()
    await writeFile(path.join(home, '.codex', 'auth.json'), formatJson({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'official-oauth-token' }
    }))
    await writeFile(path.join(home, '.codex', 'config.toml'), [
      'model_provider = "openai"',
      '[model_providers.wzw]',
      'name = "wzw"',
      'base_url = "https://wzw.pp.ua/v1"',
      'wire_api = "responses"',
      'auth_type = "key"',
      'requires_openai_auth = true',
      '[model_providers.wzw.auth]',
      'command = "/usr/bin/jq"',
      'args = ["-r", ".OPENAI_API_KEY", "/home/example/.codex/auth.json.key.wzw"]',
      ''
    ].join('\n'))

    const prepared = await new CodexAdapter({ homeDir: home, vault }).prepareActivation('codex-official')
    const configMutation = prepared.mutations.find((mutation) => mutation.path.endsWith('/config.toml'))
    const config = parseToml(configMutation?.content ?? '') as Record<string, any>
    const wzw = config.model_providers.wzw as Record<string, any>

    expect(wzw.requires_openai_auth).toBeUndefined()
    expect(wzw.auth.args).toEqual(['-r', '.OPENAI_API_KEY', path.join(home, '.codex', 'auth.json.key.wzw')])
  })

  it('prepares isolated Codex Official and Mega launch commands', async () => {
    const { home, appData, vault } = await fixture()
    await vault.set('codex:mega', 'launch-mega-key')
    await vault.set('grok:mega', 'launch-grok-key')
    await vault.set('claude:bai', 'launch-claude-key')
    await writeFile(path.join(home, '.claude', 'settings.json'), formatJson({ env: { EDITOR: 'vim' } }))
    await writeFile(path.join(home, '.claude', '.credentials.json'), formatJson({ claudeAiOauth: { accessToken: 'claude-oauth-token' } }))
    await writeFile(path.join(home, '.codex', 'auth.json'), formatJson({ auth_mode: 'chatgpt', tokens: { access_token: 'live-oauth-token' } }))
    await writeFile(path.join(home, '.codex', 'auth.json.oauth'), formatJson({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: 'oauth-token' } }))
    await writeFile(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.6-sol"\n')
    const manager = new AgentManager(home, appData, vault)
    await manager.initialize()

    const official = await manager.prepareLaunch('codex-official')
    const mega = await manager.prepareLaunch('codex-mega')
    const claude = await manager.prepareLaunch('claude-bai')
    const claudeOfficial = await manager.prepareLaunch('claude-official')
    const grok = await manager.prepareLaunch('grok-mega')
    const agy = await manager.prepareLaunch('antigravity-google')

    expect(official.command).toContain('run-profiles/codex/codex-official')
    expect(mega.command).toContain('run-profiles/codex/codex-mega')
    expect(official.command).toContain('codex -p official')
    expect(official.command).toContain('env -u OPENAI_API_KEY')
    expect(mega.command).toContain('codex -p mega')
    expect(claude.command).toContain('claude --settings')
    expect(claude.command).toContain('CLAUDE_CONFIG_DIR=')
    expect(claudeOfficial.command).toContain('CLAUDE_CONFIG_DIR=')
    expect(claudeOfficial.command).toContain('claude --settings')
    expect(grok.command).toContain('GROK_HOME=')
    expect(grok.command).toContain('grok --model grok-4.6')
    expect(grok.command).not.toContain(' -p ')
    expect(agy.command).toBe('agy --model gemini-2.5-pro')
    expect(official.command).not.toContain('oauth-token')
    expect(mega.command).not.toContain('launch-mega-key')
    expect(official.isolation).toBe('profile')
    expect(mega.isolation).toBe('profile')

    const officialDir = path.join(appData, 'run-profiles', 'codex', 'codex-official')
    const megaDir = path.join(appData, 'run-profiles', 'codex', 'codex-mega')
    const claudeOfficialDir = path.join(appData, 'run-profiles', 'claude', 'claude-official')
    const officialConfig = parseToml(await readFile(path.join(officialDir, 'config.toml'), 'utf8')) as Record<string, unknown>
    const officialProfileConfig = parseToml(await readFile(path.join(officialDir, 'official.config.toml'), 'utf8')) as Record<string, unknown>
    const megaConfig = parseToml(await readFile(path.join(megaDir, 'config.toml'), 'utf8')) as Record<string, any>
    const megaProfileConfig = parseToml(await readFile(path.join(megaDir, 'mega.config.toml'), 'utf8')) as Record<string, any>
    expect(officialConfig.model_provider).toBe('openai')
    expect(officialProfileConfig.model_provider).toBe('openai')
    expect(megaConfig.model_provider).toBe('mega')
    expect(megaProfileConfig.model_provider).toBe('mega')
    expect(megaConfig.model_providers.mega).toMatchObject({ base_url: 'https://mega-api.i-tetris.com/v1', auth_type: 'key' })
    expect(megaConfig.model_providers.mega.auth.args).toEqual(['-r', '.OPENAI_API_KEY', path.join(megaDir, 'auth.json.key.mega')])
    expect(JSON.parse(await readFile(path.join(officialDir, 'auth.json'), 'utf8'))).toMatchObject({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'live-oauth-token' }
    })
    expect(JSON.parse(await readFile(path.join(claudeOfficialDir, '.credentials.json'), 'utf8'))).toMatchObject({ claudeAiOauth: { accessToken: 'claude-oauth-token' } })
    expect(JSON.parse(await readFile(path.join(megaDir, 'auth.json.key.mega'), 'utf8'))).toMatchObject({ auth_mode: 'apikey', OPENAI_API_KEY: 'launch-mega-key' })
    expect(await readFile(path.join(megaDir, 'auth.json'), 'utf8').catch(() => undefined)).toBeUndefined()
    manager.dispose()
  })

  it('falls back when an external provider state is unknown', async () => {
    const { home, appData, vault } = await fixture()
    await writeFile(path.join(home, '.claude', '.current_provider'), 'not-a-real-provider\n')
    const manager = new AgentManager(home, appData, vault)
    await manager.initialize()
    expect((await manager.getState()).agents.find((agent) => agent.id === 'claude')?.activeProfileId).toBe('claude-bai')
    manager.dispose()
  })
})
