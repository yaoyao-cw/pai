import { contextBridge, ipcRenderer } from 'electron'
import type { AgentId, AppState, PaiSwitchAPI } from '../src/shared'

const api: PaiSwitchAPI = {
  getState: () => ipcRenderer.invoke('agent:get-state'),
  switchProfile: (agent: AgentId, profileId: string) => ipcRenderer.invoke('agent:switch-profile', { agent, profileId }),
  setCredential: (profileId: string, secret: string) => ipcRenderer.invoke('credential:set', { profileId, secret }),
  testConnection: (profileId: string) => ipcRenderer.invoke('health:test', { profileId }),
  listSnapshots: (agent: AgentId) => ipcRenderer.invoke('snapshot:list', { agent }),
  restoreSnapshot: (agent: AgentId, snapshotId: string) => ipcRenderer.invoke('snapshot:restore', { agent, snapshotId }),
  launchNativeLogin: (agent: AgentId) => ipcRenderer.invoke('agent:login', { agent }),
  prepareLaunch: (profileId: string) => ipcRenderer.invoke('agent:prepare-launch', { profileId }),
  launchProfile: (profileId: string) => ipcRenderer.invoke('agent:launch-profile', { profileId }),
  onChanged: (listener: (state: AppState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state)
    ipcRenderer.on('agent:changed', handler)
    return () => ipcRenderer.removeListener('agent:changed', handler)
  }
}

contextBridge.exposeInMainWorld('paiSwitch', api)
