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
    checkNow: () => invoke('store:checkNow'),
    importJson: (text: string) => invoke('store:importJson', { text }),
    importPicked: (picks: Array<{ skinId: string; price: number | null }>, date?: string) => invoke('store:importPicked', { picks, date })
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
  pickJsonFile: () => invoke('dialog:pickJsonFile'),
  onStateChanged: (cb: () => void) => {
    const fn = () => cb()
    ipcRenderer.on('state:changed', fn)
    return () => ipcRenderer.removeListener('state:changed', fn)
  }
}

contextBridge.exposeInMainWorld('vsw', api)
export type VswApi = typeof api
