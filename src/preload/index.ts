import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppState, RelayApi, RequestLog } from '../shared/api'

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`relay:${channel}`, ...args)

const api: RelayApi = {
  getState: call('getState') as RelayApi['getState'],
  saveProvider: call('saveProvider') as RelayApi['saveProvider'],
  deleteProvider: call('deleteProvider') as RelayApi['deleteProvider'],
  setProviderEnabled: call('setProviderEnabled') as RelayApi['setProviderEnabled'],
  fetchModels: call('fetchModels') as RelayApi['fetchModels'],
  setDefaults: call('setDefaults') as RelayApi['setDefaults'],
  setStartHidden: call('setStartHidden') as RelayApi['setStartHidden'],
  setLaunchAtLogin: call('setLaunchAtLogin') as RelayApi['setLaunchAtLogin'],
  setLanguage: call('setLanguage') as RelayApi['setLanguage'],
  setTheme: call('setTheme') as RelayApi['setTheme'],
  setAccent: call('setAccent') as RelayApi['setAccent'],
  getUsage: call('getUsage') as RelayApi['getUsage'],
  clearUsage: call('clearUsage') as RelayApi['clearUsage'],
  regenerateKey: call('regenerateKey') as RelayApi['regenerateKey'],
  setPort: call('setPort') as RelayApi['setPort'],
  applyIntegration: call('applyIntegration') as RelayApi['applyIntegration'],
  restoreIntegration: call('restoreIntegration') as RelayApi['restoreIntegration'],
  copyProviderKey: call('copyProviderKey') as RelayApi['copyProviderKey'],
  setPin: call('setPin') as RelayApi['setPin'],
  removePin: call('removePin') as RelayApi['removePin'],
  resetPin: call('resetPin') as RelayApi['resetPin'],
  setSystemAuth: call('setSystemAuth') as RelayApi['setSystemAuth'],
  openExternal: call('openExternal') as RelayApi['openExternal'],
  onLog(callback) {
    const listener = (_e: IpcRendererEvent, log: RequestLog) => callback(log)
    ipcRenderer.on('relay:log', listener)
    return () => ipcRenderer.off('relay:log', listener)
  },
  onState(callback) {
    const listener = (_e: IpcRendererEvent, state: AppState) => callback(state)
    ipcRenderer.on('relay:state', listener)
    return () => ipcRenderer.off('relay:state', listener)
  }
}

contextBridge.exposeInMainWorld('relay', api)
