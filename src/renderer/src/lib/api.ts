import type { CatalogSkin, CheckRun, ContentTier, ErrorLogEntry, MonitorState, NotificationRecord, Priority, StoredSnapshot, Weapon, WishlistItem } from '../../../core/types'
import type { Settings } from '../../../core/settings'

export type { CatalogSkin, CheckRun, ContentTier, ErrorLogEntry, MonitorState, NotificationRecord, Priority, StoredSnapshot, Weapon, WishlistItem, Settings }

export interface AppState {
  version: string
  settings: Settings
  monitor: MonitorState
  paused: boolean
  schedulerRunning: boolean
  checking: boolean
  plan: { dueAt: string; reason: string } | null
  provider: {
    id: string
    name: string
    supportsAutomatic: boolean
    usesUnofficialRiotApi: boolean
    status: { ready: boolean; message: string; accountLabel?: string | null }
    ready: boolean
  }
  fetchError: { message: string | null; at: string } | null
  update: UpdateState | null
  latestStore: StoredSnapshot | null
  latestIsCurrent: boolean
  matchedSkinIds: string[]
  accountStores: Array<{ key: string; label: string; store: StoredSnapshot | null; matchedSkinIds: string[]; isCurrent: boolean }>
  wishlistCount: number
  catalog: { skinCount: number; version: string | null; updatedAt: string | null }
  webhookConfigured: boolean
  discordBot: { configured: boolean; userId: string | null; app: { id: string; name: string } | null; links: { userInstall: string; serverInvite: string } | null }
  notifierConfigured: boolean
  riot: {
    loggedIn: boolean
    needsRelogin: boolean
    account: { puuid: string; gameName: string | null; region: string | null } | null
    maxAccounts: number
    accounts: RiotAccount[]
  }
  secureStorageAvailable: boolean
  lastRun: CheckRun | null
}

export interface RiotAccount {
  key: string
  label: string
  gameName: string | null
  region: string | null
  regionOverride: string
  loggedIn: boolean
  needsRelogin: boolean
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'
  currentVersion: string
  version: string | null
  releaseNotes: string | null
  progress: number | null
  error: string | null
  checkedAt: string | null
}

export interface CheckSummary {
  status: 'success' | 'error' | 'skipped'
  message: string
  matched: number
  notified: number
}

export interface HistoryData {
  snapshots: StoredSnapshot[]
  stats: Array<{ skinId: string; count: number; lastSeen: string; skin: CatalogSkin | null }>
  notifications: NotificationRecord[]
  runs: CheckRun[]
  errors: ErrorLogEntry[]
}

export interface Diagnostics {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  userData: string
  dbSchema: number
  logs: string
  loginItem: boolean
}

interface VswApi {
  getState(): Promise<AppState>
  catalog: { list(): Promise<{ skins: CatalogSkin[]; weapons: Weapon[]; tiers: ContentTier[] }>; update(force: boolean): Promise<AppState['catalog']> }
  wishlist: {
    list(): Promise<WishlistItem[]>
    add(skinId: string, priority?: Priority): Promise<WishlistItem>
    remove(skinId: string): Promise<boolean>
    setPriority(skinId: string, priority: Priority): Promise<void>
    reorder(ids: string[]): Promise<void>
  }
  store: {
    checkNow(): Promise<CheckSummary>
  }
  history(): Promise<HistoryData>
  settings: { update(patch: Partial<Settings>): Promise<Settings> }
  webhook: { set(url: string): Promise<boolean>; clear(): Promise<boolean>; test(url?: string): Promise<{ ok: boolean; message: string }> }
  monitor: { setPaused(paused: boolean): Promise<void> }
  diagnostics(): Promise<Diagnostics>
  openExternal(url: string): Promise<void>
  openLogs(): Promise<void>
  bot: {
    set(userId: string, token?: string): Promise<{ app: { id: string; name: string }; links: { userInstall: string; serverInvite: string } }>
    clear(): Promise<boolean>
    test(): Promise<{ ok: boolean; message: string }>
  }
  tier: {
    load(): Promise<unknown>
    save(data: unknown): Promise<boolean>
    export(action: 'save' | 'copy' | 'sharex', spec: unknown): Promise<{ ok: boolean; canceled?: boolean; path?: string; copied?: boolean; shared?: boolean }>
  }
  update: { check(): Promise<UpdateState>; download(): Promise<UpdateState>; install(): Promise<void> }
  riot: {
    login(key?: string, label?: string): Promise<{ account: { key: string; label: string } | null; check: CheckSummary }>
    loginWithSsid(ssid: string, key?: string, label?: string): Promise<{ account: { key: string; label: string } | null; check: CheckSummary }>
    rename(key: string, label: string): Promise<boolean>
    setRegion(key: string, region: string): Promise<boolean>
    removeAccount(key: string): Promise<boolean>
    logout(): Promise<boolean>
  }
  onStateChanged(cb: () => void): () => void
}

declare global {
  interface Window {
    vsw: VswApi
  }
}

export const api = (): VswApi => window.vsw

/** Strips Electron's "Error invoking remote method 'x': Error: " prefix. */
export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
