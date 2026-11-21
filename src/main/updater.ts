import { app } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { Logger } from './logger'

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  version: string | null
  releaseNotes: string | null
  progress: number | null
  error: string | null
  checkedAt: string | null
}

/**
 * In-app updates from GitHub Releases (latest.yml + installer published by the release workflow).
 * Downloads only when the user presses the button; installs on "restart to update" or on quit.
 */
export class AppUpdater {
  state: UpdateState = { status: 'idle', currentVersion: app.getVersion(), version: null, releaseNotes: null, progress: null, error: null, checkedAt: null }

  constructor(
    private logger: Logger,
    private onChange: (s: UpdateState) => void
  ) {
    if (!app.isPackaged) {
      this.state.status = 'unsupported'
      return
    }
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = { info: (m: unknown) => logger.info(`[update] ${m}`), warn: (m: unknown) => logger.warn(`[update] ${m}`), error: (m: unknown) => logger.warn(`[update] ${m}`), debug: () => undefined }
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }))
    autoUpdater.on('update-available', (i: UpdateInfo) => this.set({ status: 'available', version: i.version, releaseNotes: notes(i), checkedAt: new Date().toISOString() }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'not-available', version: null, checkedAt: new Date().toISOString() }))
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', progress: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (i) => this.set({ status: 'downloaded', version: i.version, progress: 100 }))
    autoUpdater.on('error', (e) => this.set({ status: 'error', error: friendly(e), checkedAt: new Date().toISOString() }))
  }

  private set(p: Partial<UpdateState>): void {
    this.state = { ...this.state, ...p }
    this.onChange(this.state)
  }

  get supported(): boolean {
    return this.state.status !== 'unsupported'
  }

  async check(): Promise<UpdateState> {
    if (!this.supported || this.state.status === 'downloading' || this.state.status === 'downloaded') return this.state
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      this.set({ status: 'error', error: friendly(e), checkedAt: new Date().toISOString() })
    }
    return this.state
  }

  async download(): Promise<UpdateState> {
    if (this.state.status !== 'available') return this.state
    this.set({ status: 'downloading', progress: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (e) {
      this.set({ status: 'error', error: friendly(e) })
    }
    return this.state
  }

  /** Quits and runs the installer silently, then relaunches the app. */
  install(): void {
    if (this.state.status === 'downloaded') autoUpdater.quitAndInstall(true, true)
  }
}

function notes(i: UpdateInfo): string | null {
  if (typeof i.releaseNotes === 'string') return i.releaseNotes.replace(/<[^>]+>/g, '').slice(0, 2000)
  if (Array.isArray(i.releaseNotes)) return i.releaseNotes.map((n) => n.note ?? '').join('\n').replace(/<[^>]+>/g, '').slice(0, 2000)
  return null
}

function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (/404|Not Found|Unable to find latest version/i.test(m)) return '更新情報を取得できませんでした（配布元のリポジトリが非公開か、リリースが見つかりません）'
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::/i.test(m)) return 'インターネットに接続できませんでした'
  if (/latest\.yml/i.test(m)) return 'リリースに更新情報ファイル (latest.yml) がありません'
  return m.split('\n')[0].slice(0, 200)
}
