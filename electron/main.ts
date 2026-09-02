import { app, BrowserWindow, ipcMain, Menu, nativeImage, safeStorage, Tray } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { AgentId, AppState } from '../src/shared'
import { CredentialVault } from './services/credential-vault'
import { AgentManager } from './services/agent-manager'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Electron 36 can load GTK 2/3 and GTK 4 together on some Linux desktops;
// selecting GTK 3 keeps the process stable without changing the renderer.
if (process.platform === 'linux') app.commandLine.appendSwitch('gtk-version', '3')

const remoteDebuggingPort = process.env.PAI_SWITCH_CDP_PORT
if (remoteDebuggingPort) {
  const port = Number(remoteDebuggingPort)
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('PAI_SWITCH_CDP_PORT must be an integer between 1024 and 65535')
  }
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  app.commandLine.appendSwitch('remote-debugging-port', String(port))
}

const agentSchema = z.enum(['claude', 'codex', 'antigravity', 'grok'])
const profileRequest = z.object({ agent: agentSchema, profileId: z.string().min(1).max(120) })
const credentialRequest = z.object({ profileId: z.string().min(1).max(120), secret: z.string().min(1).max(100_000) })
const snapshotRequest = z.object({ agent: agentSchema, snapshotId: z.string().regex(/^[0-9a-f-]+$/i) })
const profileOnlyRequest = z.object({ profileId: z.string().min(1).max(120) })

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let manager: AgentManager | undefined

function isTrustedRendererUrl(url: string): boolean {
  let isDev = false
  try {
    const parsed = new URL(url)
    isDev = parsed.protocol === 'http:' && parsed.port === '5173' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
  } catch {
    // Invalid sender URLs are rejected below.
  }
  let isFile = false
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      const filePath = fileURLToPath(parsed)
      const distRoot = path.resolve(__dirname, '../dist')
      isFile = filePath === path.join(distRoot, 'index.html') || filePath.startsWith(`${distRoot}${path.sep}`)
    }
  } catch {
    // Invalid sender URLs are rejected below.
  }
  return isDev || isFile
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  if (!isTrustedRendererUrl(event.senderFrame?.url ?? '')) throw new Error('Untrusted IPC sender')
}

function requireManager(): AgentManager {
  if (!manager) throw new Error('Application is not ready')
  return manager
}

function registerIpc(): void {
  ipcMain.handle('agent:get-state', async (event) => { assertTrustedSender(event); return requireManager().getState() })
  ipcMain.handle('agent:switch-profile', async (event, input: unknown) => {
    assertTrustedSender(event)
    const { agent, profileId } = profileRequest.parse(input)
    return requireManager().switchProfile(agent as AgentId, profileId)
  })
  ipcMain.handle('credential:set', async (event, input: unknown) => {
    assertTrustedSender(event)
    const { profileId, secret } = credentialRequest.parse(input)
    await requireManager().setCredential(profileId, secret)
  })
  ipcMain.handle('health:test', async (event, input: unknown) => {
    assertTrustedSender(event)
    const { profileId } = profileOnlyRequest.parse(input)
    return requireManager().testConnection(profileId)
  })
  ipcMain.handle('snapshot:list', async (event, input: unknown) => {
    assertTrustedSender(event)
    const { agent } = z.object({ agent: agentSchema }).parse(input)
    return requireManager().listSnapshots(agent as AgentId)
  })
  ipcMain.handle('snapshot:restore', async (event, input: unknown) => {
    assertTrustedSender(event)
    const { agent, snapshotId } = snapshotRequest.parse(input)
    await requireManager().restoreSnapshot(agent as AgentId, snapshotId)
  })
  ipcMain.handle('agent:login', async (event, input: unknown) => {
    assertTrustedSender(event)
    const { agent } = z.object({ agent: agentSchema }).parse(input)
    await requireManager().launchNativeLogin(agent as AgentId)
  })
  ipcMain.handle('agent:prepare-launch', async (event, input: unknown) => {
    assertTrustedSender(event)
    const { profileId } = profileOnlyRequest.parse(input)
    return requireManager().prepareLaunch(profileId)
  })
  ipcMain.handle('agent:launch-profile', async (event, input: unknown) => {
    assertTrustedSender(event)
    const { profileId } = profileOnlyRequest.parse(input)
    return requireManager().launchProfile(profileId)
  })
}

function makeTray(): void {
  const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><rect width="18" height="18" rx="4" fill="#17201e"/><path d="M5 9.2 7.6 12 13 6.5" fill="none" stroke="#81d0b1" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg)}`)
  tray = new Tray(icon)
  tray.setToolTip('pai-switch')
  tray.on('click', () => mainWindow?.show())
  void refreshTray()
}

async function refreshTray(): Promise<void> {
  if (!tray || !manager) return
  const state = await manager.getState()
  const agentItems = state.agents.map((agent) => ({
    label: `${agent.label}: ${agent.profiles.find((profile) => profile.id === agent.activeProfileId)?.name ?? '未配置'}`,
    submenu: agent.profiles.map((profile) => ({
      label: profile.name,
      type: 'radio' as const,
      checked: profile.id === agent.activeProfileId,
      click: async () => {
        try {
          await manager?.switchProfile(agent.id, profile.id)
          await refreshTray()
        } catch (error) {
          console.error(`Tray switch failed for ${agent.id}/${profile.id}`, error)
        }
      }
    }))
  }))
  tray.setContextMenu(Menu.buildFromTemplate([
    ...agentItems,
    { type: 'separator' },
    { label: '打开 pai-switch', click: () => mainWindow?.show() },
    { label: '退出', click: () => app.quit() }
  ]))
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f4f3ef',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Renderer failed to load (${errorCode}): ${errorDescription} - ${validatedURL}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Renderer process exited: ${details.reason} (${details.exitCode})`)
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = undefined })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    if (!isTrustedRendererUrl(devUrl)) throw new Error('Refusing to load an untrusted development renderer URL')
    await mainWindow.loadURL(devUrl)
  }
  else await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
}

async function bootstrap(): Promise<void> {
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  await app.whenReady()
  const vault = new CredentialVault(path.join(app.getPath('userData'), 'vault.json'), safeStorage)
  manager = new AgentManager(app.getPath('home'), app.getPath('userData'), vault)
  await manager.initialize()
  registerIpc()
  manager.onChanged((state: AppState) => {
    mainWindow?.webContents.send('agent:changed', state)
    void refreshTray()
  })
  await createWindow()
  makeTray()
  app.on('activate', () => { if (!mainWindow) void createWindow(); else mainWindow.show() })
}

void bootstrap().catch((error) => {
  console.error('pai-switch failed to start', error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => manager?.dispose())
