import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, powerMonitor, shell, Tray, type IpcMainInvokeEvent } from 'electron'
import { WatcherCore, repairSettings, DiscordBotClient, botInstallLinks, isValidBotToken, isValidUserId, webhookNotifier, RiotStoreProvider, RiotAuthRequiredError, parseSsidInput, isValidWebhookUrl, formatZonedDateTime, type CheckPlan } from '../core'
import { matchWishlist } from '../core/monitor/matcher'
import { IpcSchemas, type IpcChannel } from './ipcSchemas'
import { Logger } from './logger'
import { SecretStore } from './secrets'
import { electronAuthorize, openRiotLoginWindow, silentRiotLogin, wipeRiotSessions } from './riotAuth'
import { AppUpdater } from './updater'

const WEBHOOK_KEY = 'discord.webhook'
const RIOT_COOKIES_KEY = 'riot.cookies'
const BOT_TOKEN_KEY = 'discord.botToken'
const isDev = !app.isPackaged && process.env.ELECTRON_RENDERER_URL !== undefined
const startHiddenArg = process.argv.includes('--hidden')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let core: WatcherCore
let secrets: SecretStore
let logger: Logger
let quitting = false
let paused = false
let lastPlan: CheckPlan | null = null
let catalogTimer: NodeJS.Timeout | null = null
let trayHintShown = false
let riot: RiotStoreProvider
let reloginNotified = false
let updater: AppUpdater
let keepAliveTimer: NodeJS.Timeout | null = null
let loginInProgress: Promise<unknown> | null = null

app.setAppUserModelId('com.vsw.valorant-store-watcher')
// Optional override (portable use / automated UI tests)
if (process.env.VSW_USER_DATA) app.setPath('userData', process.env.VSW_USER_DATA)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(bootstrap).catch((e) => {
    dialog.showErrorBox('VALORANT Store Watcher', `起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    app.exit(1)
  })
}

function resourcePath(...p: string[]): string {
  return app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(app.getAppPath(), 'resources', ...p)
}

function wasmPath(): string {
  // Electron's fs can read files inside app.asar directly
  return require.resolve('sql.js/dist/sql-wasm.wasm')
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData')
  logger = new Logger(path.join(userData, 'logs'))
  secrets = new SecretStore(path.join(userData, 'secrets.json'))
  logger.info(`起動 v${app.getVersion()} (${process.platform})`)

  core = await WatcherCore.create({
    dbPath: path.join(userData, 'vsw.sqlite'),
    wasmPath: wasmPath(),
    fetchImpl: (url, init) => net.fetch(url, init),
    getWebhookUrl: async () => secrets.get(WEBHOOK_KEY),
    getNotifier: async () => currentNotifier(),
    onChange: () => {
      if (riot?.needsRelogin && !reloginNotified && Notification.isSupported()) {
        reloginNotified = true
        const n = new Notification({ title: 'VALORANT Store Watcher', body: 'Riotへの再ログインが必要です。ここをクリックするとログイン画面を開きます。' })
        n.on('click', () => void startRiotLogin().catch((e) => logger.warn('再ログイン失敗', e)))
        n.show()
      }
      broadcast()
    },
    onResult: (r) => {
      // Windows toast notifications (independent from Discord). Clicking one opens the app.
      if (!Notification.isSupported()) return
      for (const d of r.desktop) {
        const n = new Notification({ title: d.title, body: d.body })
        n.on('click', () => showWindow())
        n.show()
      }
    },
    onPlan: (p) => {
      lastPlan = p
      updateTray()
    }
  })

  riot = new RiotStoreProvider({
    fetchImpl: (url, init) => net.fetch(url, init),
    authorize: electronAuthorize,
    loadCookies: loadRiotCookies,
    saveCookies: (jar) => secrets.set(RIOT_COOKIES_KEY, JSON.stringify(jar)),
    loadAccount: () => core.loadRiotAccount(),
    saveAccount: (a) => core.saveRiotAccount(a),
    getRegionSetting: () => core.repos.settings.get().riotRegion,
    getClientVersion: () => core.riotClientVersion(),
    riskAcknowledged: () => core.repos.settings.get().riskAcknowledged,
    silentRelogin: async () => {
      logger.info('保存済みのRiotセッションでの自動再ログインを試みます')
      const r = await silentRiotLogin(loadRiotCookies())
      logger.info(r ? '自動再ログインに成功しました' : '自動再ログインできませんでした（手動ログインが必要）')
      return r
    }
  })
  core.registerProvider(riot)

  // undo settings resets caused by versions ≤ 1.3.1 (see repairSettings)
  const fix = repairSettings(core.repos.settings.get(), {
    riotLoggedIn: riot.loggedIn,
    webhookConfigured: secrets.has(WEBHOOK_KEY),
    botConfigured: secrets.has(BOT_TOKEN_KEY),
    botUserId: core.repos.meta.get('discord_bot_user')
  })
  if (Object.keys(fix).length) {
    core.repos.settings.update(fix)
    logger.info(`リセットされていた設定を復元しました: ${Object.keys(fix).join(', ')}`)
  }

  registerIpc()
  createTray()
  const s = core.repos.settings.get()
  applyLoginItem(s.launchAtLogin)
  if (!(startHiddenArg && s.startHidden)) createWindow()

  // catalog: refresh when stale (version-checked, so usually one tiny request).
  // On first launch the store check needs the catalog, so wait for it before starting the scheduler.
  const firstRun = core.repos.catalog.count() === 0
  const catalogReady = refreshCatalog(false)
  if (firstRun) await catalogReady
  catalogTimer = setInterval(() => void refreshCatalog(false), 6 * 3600_000)

  if (!paused) core.scheduler.start()

  // keep the Riot session fresh so the saved login lasts as long as possible
  const keepAlive = () =>
    void riot
      .keepAlive()
      .then((did) => did && logger.info('Riotセッションを更新しました'))
      .catch((e) => logger.warn('Riotセッションの更新に失敗', e))
      .finally(() => broadcast())
  keepAliveTimer = setInterval(keepAlive, 3600_000)
  setTimeout(keepAlive, 90_000)

  // in-app updates
  updater = new AppUpdater(logger, (st) => {
    broadcast()
    if (st.status === 'available' && Notification.isSupported()) {
      const n = new Notification({ title: 'VALORANT Store Watcher', body: `新しいバージョン v${st.version} があります。クリックして更新できます。` })
      n.on('click', () => showWindow())
      n.show()
    }
  })
  setTimeout(() => void updater.check(), 30_000)
  setInterval(() => void updater.check(), 12 * 3600_000)
  powerMonitor.on('resume', () => {
    logger.info('スリープから復帰: ストアを確認します')
    void core.scheduler.tick('startup')
  })
  powerMonitor.on('unlock-screen', () => void core.scheduler.tick())
}

async function refreshCatalog(force: boolean): Promise<void> {
  const s = core.repos.settings.get()
  if (!force && (!s.catalogAutoUpdate && core.repos.catalog.count() > 0)) return
  if (!force && !core.catalogService.isStale(24)) return
  try {
    const st = await core.catalogService.update(force)
    logger.info(`カタログ更新: ${st.skinCount} スキン`)
  } catch (e) {
    logger.warn('カタログ更新に失敗', e)
    core.repos.errors.add('catalog', e)
  }
  broadcast()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0f17',
    title: 'VALORANT Store Watcher',
    icon: resourcePath('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })
  Menu.setApplicationMenu(null)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (e) => {
    if (!quitting && core.repos.settings.get().closeToTray) {
      e.preventDefault()
      mainWindow?.hide()
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true
        new Notification({ title: 'VALORANT Store Watcher', body: 'トレイに常駐して監視を続けています。終了はトレイアイコンの右クリックから。' }).show()
      }
    }
  })
  mainWindow.on('closed', () => (mainWindow = null))
  // security: block navigation & new windows; open safe links externally
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault()
  })
  if (isDev) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function isAppUrl(url: string): boolean {
  if (isDev && url.startsWith(process.env.ELECTRON_RENDERER_URL!)) return true
  return url.startsWith('file://')
}

const EXTERNAL_ALLOW = ['https://discord.com/', 'https://auth.riotgames.com/', 'https://support.discord.com/', 'https://valorant-api.com/', 'https://developer.riotgames.com/', 'https://www.riotgames.com/', 'https://github.com/']
function openExternalSafe(url: string): void {
  if (EXTERNAL_ALLOW.some((p) => url.startsWith(p))) void shell.openExternal(url)
}

function showWindow(): void {
  if (!mainWindow) createWindow()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

function monitorLabel(): string {
  if (paused) return '⏸ 監視一時停止中'
  const s = core.repos.settings.get()
  if (!s.autoCheckEnabled) return '⏹ 自動チェック無効'
  if (core.provider.id === 'riot' && riot?.needsRelogin) return '⚠ Riotへの再ログインが必要'
  if (core.provider.canRunAutomatically && !core.provider.canRunAutomatically()) return '⚠ 取得の準備ができていません'
  if (core.checkService.isRunning) return '🔄 チェック中…'
  if (lastPlan) return `🟢 監視中（次回 ${formatZonedDateTime(lastPlan.dueAt, s.timezone)}）`
  return '🟢 監視中'
}

function createTray(): void {
  const img = nativeImage.createFromPath(resourcePath('tray.png'))
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(resourcePath('icon.png')).resize({ width: 16, height: 16 }) : img)
  tray.on('click', () => showWindow())
  updateTray()
}

function updateTray(): void {
  if (!tray || !core) return
  const label = monitorLabel()
  tray.setToolTip(`VALORANT Store Watcher\n${label}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'アプリを開く', click: () => showWindow() },
      { label: '今すぐチェック', click: () => void core.checkService.runCheck('manual') },
      ...(riot?.needsRelogin || (core.repos.settings.get().providerId === 'riot' && riot && !riot.loggedIn && core.repos.settings.get().riskAcknowledged)
        ? [{ label: '⚠ Riotにログイン', click: () => void startRiotLogin().catch((e) => logger.warn('ログイン失敗', e)) }]
        : []),
      { label: paused ? '監視を再開' : '監視を一時停止', click: () => setPaused(!paused) },
      { type: 'separator' },
      {
        label: '終了',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function setPaused(p: boolean): void {
  paused = p
  if (p) core.scheduler.stop()
  else core.scheduler.start()
  updateTray()
  broadcast()
}

function applyLoginItem(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
  } catch (e) {
    logger.warn('自動起動の設定に失敗', e)
  }
}

let broadcastTimer: NodeJS.Timeout | null = null
function broadcast(): void {
  updateTray()
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    mainWindow?.webContents.send('state:changed')
  }, 100)
}

async function buildState() {
  const settings = core.repos.settings.get()
  const provider = core.provider
  const latest = core.repos.stores.latest(provider.id)
  const lastRun = core.repos.runs.lastFor(provider.id)
  const status = await provider.status(core.checkService.providerContext())
  const wishlist = core.repos.wishlist.list()
  const matches = latest ? matchWishlist(latest.offers, wishlist) : []
  const plan = core.scheduler.plan()
  return {
    version: app.getVersion(),
    settings,
    monitor: core.repos.monitor.get(),
    paused,
    schedulerRunning: core.scheduler.running && !paused,
    checking: core.checkService.isRunning,
    plan: plan && !paused ? { dueAt: plan.dueAt.toISOString(), reason: plan.reason } : null,
    provider: {
      id: provider.id,
      name: provider.displayName,
      supportsAutomatic: provider.supportsAutomatic,
      usesUnofficialRiotApi: provider.usesUnofficialRiotApi,
      status,
      ready: status.ready && (provider.canRunAutomatically?.() ?? true)
    },
    // the latest check of the CURRENT source failed → shown instead of a stale store
    fetchError: lastRun?.status === 'error' ? { message: lastRun.message, at: lastRun.finishedAt ?? lastRun.startedAt } : null,
    update: updater?.state ?? null,
    latestStore: latest,
    latestIsCurrent: !!latest?.periodEnd && new Date(latest.periodEnd).getTime() > Date.now(),
    matchedSkinIds: matches.map((m) => m.offer.skinId),
    wishlistCount: wishlist.length,
    catalog: core.catalogService.status(),
    webhookConfigured: secrets.has(WEBHOOK_KEY),
    discordBot: (() => {
      const app = botAppInfo()
      return { configured: secrets.has(BOT_TOKEN_KEY), userId: settings.discordUserId, app, links: app ? botInstallLinks(app.id) : null }
    })(),
    notifierConfigured: currentNotifier() !== null,
    riot: { loggedIn: riot.loggedIn, needsRelogin: riot.needsRelogin, account: core.loadRiotAccount() },
    secureStorageAvailable: secrets.available(),
    lastRun
  }
}

function handle<C extends IpcChannel>(channel: C, fn: (arg: import('./ipcSchemas').IpcArg<C>, e: IpcMainInvokeEvent) => unknown): void {
  ipcMain.handle(channel, async (e, raw) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url)) throw new Error('不正な送信元です')
    const parsed = IpcSchemas[channel].safeParse(raw)
    if (!parsed.success) throw new Error(`入力値が不正です: ${parsed.error.issues.map((i) => i.message).join(', ')}`)
    try {
      return await fn(parsed.data as never, e)
    } catch (err) {
      logger.warn(`IPC ${channel} 失敗`, err)
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })
}

function registerIpc(): void {
  handle('app:getState', () => buildState())
  handle('catalog:list', () => ({ skins: core.repos.catalog.allSkins(), weapons: core.repos.catalog.weapons(), tiers: core.repos.catalog.tiers() }))
  handle('catalog:update', async ({ force }) => {
    const st = await core.catalogService.update(force)
    broadcast()
    return st
  })
  handle('wishlist:list', () => core.repos.wishlist.list())
  handle('wishlist:add', ({ skinId, priority }) => {
    const r = core.repos.wishlist.add(skinId, priority)
    broadcast()
    return r
  })
  handle('wishlist:remove', ({ skinId }) => {
    const r = core.repos.wishlist.remove(skinId)
    broadcast()
    return r
  })
  handle('wishlist:setPriority', ({ skinId, priority }) => {
    core.repos.wishlist.setPriority(skinId, priority)
    broadcast()
  })
  handle('wishlist:reorder', ({ ids }) => {
    core.repos.wishlist.reorder(ids.map((i) => i.toLowerCase()))
    broadcast()
  })
  handle('store:checkNow', async () => {
    const last = core.repos.runs.list(1)[0]
    if (last && last.trigger === 'manual' && Date.now() - new Date(last.startedAt).getTime() < 30_000) {
      throw new Error('連続チェックを防ぐため、30秒ほど待ってから再実行してください')
    }
    return summarize(await core.checkService.runCheck('manual'))
  })
  handle('history:get', () => ({
    snapshots: core.repos.stores.list(60),
    stats: core.repos.stores.appearanceStats(200),
    notifications: core.repos.notifications.list(300),
    runs: core.repos.runs.list(200),
    errors: core.repos.errors.list(200)
  }))
  handle('settings:update', async (patch) => {
    // revoking the risk acknowledgement also removes the Riot login (no unofficial access without consent)
    if (patch.riskAcknowledged === false && riot.loggedIn) await riotLogout()
    const s = core.repos.settings.update(patch)
    if (patch.launchAtLogin !== undefined) applyLoginItem(s.launchAtLogin)
    void core.scheduler.tick()
    broadcast()
    return s
  })
  handle('webhook:set', ({ url }) => {
    if (!isValidWebhookUrl(url)) throw new Error('Discord Webhook URLの形式ではありません（https://discord.com/api/webhooks/... ）')
    secrets.set(WEBHOOK_KEY, url.trim())
    logger.info('Webhook URL を更新しました')
    broadcast()
    return true
  })
  handle('webhook:clear', () => {
    secrets.delete(WEBHOOK_KEY)
    logger.info('Webhook URL を削除しました')
    broadcast()
    return true
  })
  handle('webhook:test', async ({ url }) => {
    if (url && !isValidWebhookUrl(url)) throw new Error('Discord Webhook URLの形式ではありません')
    return core.checkService.sendTest(url ? webhookNotifier((u, i) => net.fetch(u, i), url) : undefined)
  })
  handle('bot:set', async ({ token, userId }) => {
    const t = token?.trim() || secrets.get(BOT_TOKEN_KEY)
    if (!t || !isValidBotToken(t)) throw new Error('BOTトークンの形式が正しくありません')
    if (!isValidUserId(userId)) throw new Error('DiscordユーザーIDは15〜21桁の数字です')
    // verify the token before saving (also gives the app id for install links)
    const app = await new DiscordBotClient((u, i) => net.fetch(u, i), t, { maxAttempts: 2 }).application()
    if (token?.trim()) secrets.set(BOT_TOKEN_KEY, t)
    core.repos.meta.set('discord_bot_app', JSON.stringify(app))
    core.repos.settings.update({ discordUserId: userId.trim(), notifyChannel: 'bot' })
    core.repos.meta.set('discord_bot_user', userId.trim()) // backup used by repairSettings
    logger.info(`Discord BOT を設定しました: ${app.name}`)
    broadcast()
    return { app, links: botInstallLinks(app.id) }
  })
  handle('bot:clear', () => {
    secrets.delete(BOT_TOKEN_KEY)
    botClient = null
    core.repos.meta.set('discord_bot_app', null)
    core.repos.meta.set('discord_bot_user', null)
    logger.info('Discord BOT トークンを削除しました')
    broadcast()
    return true
  })
  handle('bot:test', async () => {
    const c = getBotClient()
    const uid = core.repos.settings.get().discordUserId
    if (!c || !uid) return { ok: false, message: 'BOTトークンとユーザーIDを設定してください' }
    return core.checkService.sendTest({ kind: 'bot', send: (p) => c.sendDm(uid, p) })
  })
  afterLoginFn = async (who: string) => {
    reloginNotified = false
    core.repos.monitor.set({ consecutiveFailures: 0, lastError: null, lastErrorAt: null, lastPeriodEnd: null, lastSuccessAt: null })
    core.repos.settings.update({ providerId: 'riot' })
    logger.info(`Riotログイン成功: ${who}`)
    broadcast()
    // fetch today's store right away
    const r = await core.checkService.runCheck('manual')
    return { account: core.loadRiotAccount(), check: summarize(r) }
  }
  handle('riot:login', () => startRiotLogin())
  handle('riot:loginWithSsid', async ({ ssid }) => {
    if (!core.repos.settings.get().riskAcknowledged) throw new Error('先にリスクの確認をしてください')
    const v = parseSsidInput(ssid)
    if (!v) throw new Error('ssid の形式が正しくありません')
    try {
      const a = await riot.loginWithSsid(v)
      return afterLoginFn(a.gameName ?? 'アカウント')
    } catch (e) {
      if (e instanceof RiotAuthRequiredError) throw new Error('この ssid ではログインできませんでした（期限切れか、値が違います）')
      throw e
    }
  })
  handle('riot:logout', async () => {
    await riotLogout()
    broadcast()
    return true
  })
  handle('monitor:setPaused', ({ paused: p }) => setPaused(p))
  handle('diagnostics:get', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    userData: app.getPath('userData'),
    dbSchema: core.repos.db.schemaVersion,
    logs: logger.tail(300),
    loginItem: process.platform === 'win32' || process.platform === 'darwin' ? app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin : false
  }))
  handle('update:check', () => updater.check())
  handle('update:download', () => updater.download())
  handle('update:install', () => {
    quitting = true
    updater.install()
  })
  handle('app:openExternal', ({ url }) => openExternalSafe(url))
  handle('app:openLogs', () => shell.openPath(path.dirname(logger.file)))
}

let botClient: { token: string; client: DiscordBotClient } | null = null
function getBotClient(): DiscordBotClient | null {
  const token = secrets.get(BOT_TOKEN_KEY)
  if (!token) return null
  if (botClient?.token !== token) botClient = { token, client: new DiscordBotClient((u, i) => net.fetch(u, i), token) }
  return botClient.client
}

/** Notification destination according to settings: BOT DM or Webhook channel. */
function currentNotifier(): import('../core').Notifier | null {
  const s = core.repos.settings.get()
  if (s.notifyChannel === 'bot') {
    const c = getBotClient()
    const uid = s.discordUserId
    return c && uid ? { kind: 'bot', send: (p) => c.sendDm(uid, p) } : null
  }
  const url = secrets.get(WEBHOOK_KEY)
  return url ? webhookNotifier((u, i) => net.fetch(u, i), url) : null
}

function botAppInfo(): { id: string; name: string } | null {
  const raw = core.repos.meta.get('discord_bot_app')
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function loadRiotCookies(): Record<string, string> | null {
  const raw = secrets.get(RIOT_COOKIES_KEY)
  try {
    return raw ? (JSON.parse(raw) as Record<string, string>) : null
  } catch {
    return null
  }
}

/** Removes every stored Riot credential (encrypted cookies, account info, login browser session). */
async function riotLogout(): Promise<void> {
  secrets.delete(RIOT_COOKIES_KEY)
  core.saveRiotAccount(null)
  riot.reset()
  await wipeRiotSessions()
  logger.info('Riot連携を解除し、認証情報を破棄しました')
}

let afterLoginFn: (who: string) => Promise<unknown> = async () => undefined

/** Opens the Riot login window (one at a time). If Riot remembers the session it completes instantly. */
function startRiotLogin(): Promise<unknown> {
  if (!core.repos.settings.get().riskAcknowledged) return Promise.reject(new Error('先にリスクの確認をしてください'))
  if (loginInProgress) return loginInProgress
  showWindow()
  loginInProgress = (async () => {
    const { redirectUrl, cookies } = await openRiotLoginWindow(mainWindow, loadRiotCookies())
    const a = await riot.completeLogin(redirectUrl, cookies)
    return afterLoginFn(a.gameName ?? 'アカウント')
  })().finally(() => (loginInProgress = null))
  return loginInProgress
}

function summarize(r: Awaited<ReturnType<WatcherCore['checkService']['runCheck']>>) {
  return { status: r.status, message: r.message, matched: r.matches.length, notified: r.notified }
}

app.on('before-quit', () => {
  quitting = true
  if (catalogTimer) clearInterval(catalogTimer)
  if (keepAliveTimer) clearInterval(keepAliveTimer)
  try {
    core?.close()
  } catch (e) {
    logger?.error('終了処理エラー', e)
  }
})

// keep running in tray when all windows are closed
app.on('window-all-closed', () => {
  /* no-op: the tray keeps the app alive */
})
