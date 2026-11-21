import { contextBridge, ipcRenderer } from 'electron'

/** Whitelisted, typed bridge. The renderer has no Node access and never receives secrets. */
const invoke = (channel: string, arg?: unknown) => ipcRenderer.invoke(channel, arg)

const api = {
  getState: () => invoke('app:getState'),
  catalog: {
    list: () => invoke('catalog:list'),
    update: (force: boolean) => invoke('catalog:update', { force })
  },
  wishlist: {
    list: () => invoke('wishlist:list'),
    add: (skinId: string, priority?: string) => invoke('wishlist:add', { skinId, priority }),
    remove: (skinId: string) => invoke('wishlist:remove', { skinId }),
    setPriority: (skinId: string, priority: string) => invoke('wishlist:setPriority', { skinId, priority }),
    reorder: (ids: string[]) => invoke('wishlist:reorder', { ids })
  },
  store: {
    checkNow: () => invoke('store:checkNow')
  },
  history: () => invoke('history:get'),
  settings: { update: (patch: Record<string, unknown>) => invoke('settings:update', patch) },
  webhook: {
    set: (url: string) => invoke('webhook:set', { url }),
    clear: () => invoke('webhook:clear'),
    test: (url?: string) => invoke('webhook:test', { url })
  },
  monitor: { setPaused: (paused: boolean) => invoke('monitor:setPaused', { paused }) },
  diagnostics: () => invoke('diagnostics:get'),
  openExternal: (url: string) => invoke('app:openExternal', { url }),
  openLogs: () => invoke('app:openLogs'),
  bot: {
    set: (userId: string, token?: string) => invoke('bot:set', { token, userId }),
    clear: () => invoke('bot:clear'),
    test: () => invoke('bot:test')
  },
  update: {
    check: () => invoke('update:check'),
    download: () => invoke('update:download'),
    install: () => invoke('update:install')
  },
  riot: {
    login: () => invoke('riot:login'),
    loginWithSsid: (ssid: string) => invoke('riot:loginWithSsid', { ssid }),
    logout: () => invoke('riot:logout')
  },
  onStateChanged: (cb: () => void) => {
    const fn = () => cb()
    ipcRenderer.on('state:changed', fn)
    return () => ipcRenderer.removeListener('state:changed', fn)
  }
}

contextBridge.exposeInMainWorld('vsw', api)
export type VswApi = typeof api
