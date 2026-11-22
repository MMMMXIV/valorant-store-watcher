import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, Notification, powerMonitor, shell, Tray, type IpcMainInvokeEvent } from 'electron'
import { WatcherCore, repairSettings, DiscordBotClient, botInstallLinks, isValidBotToken, isValidUserId, webhookNotifier, RiotAccountsProvider, RiotAuthRequiredError, accountDisplay, newAccountKey, MAX_RIOT_ACCOUNTS, parseSsidInput, isValidWebhookUrl, formatZonedDateTime, type CheckPlan, type RiotAccountRecord } from '../core'
import { matchWishlist } from '../core/monitor/matcher'
import { IpcSchemas, type IpcChannel } from './ipcSchemas'
import { Logger } from './logger'
import { SecretStore } from './secrets'
import { electronAuthorize, openRiotLoginWindow, silentRiotLogin, wipeRiotApiSession, wipeRiotSession } from './riotAuth'
import { renderTierImage, type TierSpec } from './tierImage'
import { AppUpdater } from './updater'

const WEBHOOK_KEY = 'discord.webhook'
const LEGACY_RIOT_COOKIES_KEY = 'riot.cookies' // v1.x single account
const riotCookiesKey = (key: string): string => `riot.cookies:${key}`
const RIOT_ACCOUNTS_META = 'riot_accounts'
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
let riot: RiotAccountsProvider
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
      const needing = riot ? riot.accounts().filter((a) => riot.isLoggedIn(a.key) && riot.needsRelogin(a.key)) : []
      if (needing.length && !reloginNotified && Notification.isSupported()) {
        reloginNotified = true
        const names = needing.map((a) => accountDisplay(a)).join('、')
        const n = new Notification({ title: 'VALORANT Store Watcher', body: `Riotへの再ログインが必要です（${names}）。ここをクリックするとログイン画面を開きます。` })
        n.on('click', () => void startRiotLogin({ key: needing[0].key }).catch((e) => logger.warn('再ログイン失敗', e)))
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

  migrateSingleRiotAccount()
  riot = new RiotAccountsProvider({
    fetchImpl: (url, init) => net.fetch(url, init),
    authorize: electronAuthorize,
    loadAccounts: loadRiotAccounts,
    saveAccounts: (list) => core.repos.meta.set(RIOT_ACCOUNTS_META, JSON.stringify(list)),
    loadCookies: loadRiotCookies,
    saveCookies: (key, jar) => secrets.set(riotCookiesKey(key), JSON.stringify(jar)),
    deleteCookies: (key) => secrets.delete(riotCookiesKey(key)),
    getClientVersion: () => core.riotClientVersion(),
    riskAcknowledged: () => core.repos.settings.get().riskAcknowledged,
    silentRelogin: async (key) => {
      const label = accountDisplay(loadRiotAccounts().find((a) => a.key === key) ?? { gameName: null, label: key })
      logger.info(`保存済みのRiotセッションでの自動再ログインを試みます: ${label}`)
      const r = await silentRiotLogin(key, loadRiotCookies(key))
      logger.info(r ? `自動再ログインに成功しました: ${label}` : `自動再ログインできませんでした（手動ログインが必要）: ${label}`)
      return r
    },
    sleepBetweenMs: 2500
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
      .then((names) => names.length && logger.info(`Riotセッションを更新しました: ${names.join('、')}`))
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

const EXTERNAL_ALLOW = ['https://discord.com/', 'https://auth.riotgames.com/', 'https://twitter.com/intent/', 'https://x.com/intent/', 'https://support.discord.com/', 'https://valorant-api.com/', 'https://developer.riotgames.com/', 'https://www.riotgames.com/', 'https://github.com/']
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
  if (core.provider.id === 'riot' && riot?.anyNeedsRelogin) return '⚠ Riotへの再ログインが必要'
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
      ...(riot
        ? riot
            .accounts()
            .filter((a) => riot.isLoggedIn(a.key) && riot.needsRelogin(a.key))
            .map((a) => ({ label: `⚠ 再ログイン: ${accountDisplay(a)}`, click: () => void startRiotLogin({ key: a.key }).catch((e) => logger.warn('ログイン失敗', e)) }))
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
  const accounts = riot.accounts()
  // per-account "today's store" for the dashboard (Riot); the mock store has a single pseudo account
  const accountStores =
    provider.id === 'riot'
      ? accounts.map((a) => {
          const st = a.puuid ? core.repos.stores.latestFor(a.puuid, 'riot') : null
          return { key: a.key, label: accountDisplay(a), store: st, matchedSkinIds: st ? matchWishlist(st.offers, core.repos.wishlist.list()).map((m) => m.offer.skinId) : [], isCurrent: !!st?.periodEnd && new Date(st.periodEnd).getTime() > Date.now() }
        })
      : []
  const latest = accountStores.find((x) => x.store)?.store ?? core.repos.stores.latest(provider.id)
  const lastRun = core.repos.runs.lastFor(provider.id)
  const status = await provider.status(core.checkService.providerContext())
  const wishlist = core.repos.wishlist.list()
  const matches = latest ? matchWishlist(latest.offers, wishlist) : []
  const allMatched = provider.id === 'riot' ? [...new Set(accountStores.filter((x) => x.isCurrent).flatMap((x) => x.matchedSkinIds))] : matches.map((m) => m.offer.skinId)
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
    matchedSkinIds: allMatched,
    accountStores,
    wishlistCount: wishlist.length,
    catalog: core.catalogService.status(),
    webhookConfigured: secrets.has(WEBHOOK_KEY),
    discordBot: (() => {
      const app = botAppInfo()
      return { configured: secrets.has(BOT_TOKEN_KEY), userId: settings.discordUserId, app, links: app ? botInstallLinks(app.id) : null }
    })(),
    notifierConfigured: currentNotifier() !== null,
    riot: {
      loggedIn: riot.loggedIn,
      needsRelogin: riot.anyNeedsRelogin,
      account: accounts[0] ? { puuid: accounts[0].puuid ?? '', gameName: accounts[0].gameName, region: accounts[0].region } : null,
      maxAccounts: MAX_RIOT_ACCOUNTS,
      accounts: accounts.map((a) => ({
        key: a.key,
        label: a.label,
        gameName: a.gameName,
        region: a.region,
        regionOverride: a.regionOverride,
        loggedIn: riot.isLoggedIn(a.key),
        needsRelogin: riot.isLoggedIn(a.key) && riot.needsRelogin(a.key)
      }))
    },
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
    if (patch.riskAcknowledged === false && riot.loggedIn) {
      for (const a of riot.accounts()) {
        riot.remove(a.key)
        await wipeRiotSession(a.key)
      }
      await wipeRiotApiSession()
      secrets.delete(LEGACY_RIOT_COOKIES_KEY)
      core.saveRiotAccount(null)
      logger.info('同意取り消しにより、すべてのRiotアカウントの認証情報を破棄しました')
    }
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
  handle('riot:login', ({ key, label }) => startRiotLogin({ key, label }))
  handle('riot:loginWithSsid', async ({ key, label, ssid }) => {
    if (!core.repos.settings.get().riskAcknowledged) throw new Error('先にリスクの確認をしてください')
    const v = parseSsidInput(ssid)
    if (!v) throw new Error('ssid の形式が正しくありません')
    try {
      const rec = key ? await riot.reloginFromSsid(key, v) : await riot.addFromSsid(newAccountKey(), label ?? defaultLabel(), v)
      return afterRiotLogin(rec)
    } catch (e) {
      if (e instanceof RiotAuthRequiredError) throw new Error('この ssid ではログインできませんでした（期限切れか、値が違います）')
      throw e
    }
  })
  handle('riot:rename', ({ key, label }) => {
    riot.rename(key, label)
    broadcast()
    return true
  })
  handle('riot:setRegion', ({ key, region }) => {
    riot.setRegion(key, region)
    void core.scheduler.tick()
    broadcast()
    return true
  })
  handle('riot:removeAccount', async ({ key }) => {
    const label = accountDisplay(riot.accounts().find((a) => a.key === key) ?? { gameName: null, label: key })
    riot.remove(key)
    await wipeRiotSession(key)
    logger.info(`Riotアカウントの連携を解除しました: ${label}`)
    if (!riot.accounts().length && core.repos.settings.get().providerId === 'riot') core.repos.settings.update({ providerId: 'mock' })
    broadcast()
    return true
  })
  handle('riot:logout', async () => {
    // remove every account and its credentials
    for (const a of riot.accounts()) {
      riot.remove(a.key)
      await wipeRiotSession(a.key)
    }
    await wipeRiotApiSession()
    secrets.delete(LEGACY_RIOT_COOKIES_KEY)
    core.saveRiotAccount(null)
    logger.info('すべてのRiotアカウントの連携を解除し、認証情報を破棄しました')
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
  handle('tier:load', () => {
    const raw = core.repos.meta.get('tierlist')
    try {
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  })
  handle('tier:save', ({ data }) => {
    core.repos.meta.set('tierlist', JSON.stringify(data))
    return true
  })
  handle('tier:export', async ({ spec, action }) => {
    const png = await renderTierImage(spec as TierSpec)
    const name = `valorant-tier-${new Date().toISOString().slice(0, 10)}.png`
    if (action === 'save') {
      const r = await dialog.showSaveDialog(mainWindow ?? undefined!, { defaultPath: name, filters: [{ name: 'PNG画像', extensions: ['png'] }] })
      if (r.canceled || !r.filePath) return { ok: false, canceled: true }
      await fs.promises.writeFile(r.filePath, png)
      logger.info('Tier表を画像に保存しました')
      return { ok: true, path: r.filePath }
    }
    const image = nativeImage.createFromBuffer(png)
    clipboard.writeImage(image)
    if (action === 'sharex') {
      const text = encodeURIComponent('私のVALORANTスキンTier表 #VALORANT #StoreWatcher')
      const url = encodeURIComponent('https://store-watcher-guide.pages.dev/')
      await shell.openExternal(`https://x.com/intent/tweet?text=${text}&url=${url}`)
      return { ok: true, copied: true, shared: true }
    }
    return { ok: true, copied: true }
  })
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

function loadRiotCookies(key: string): Record<string, string> | null {
  const raw = secrets.get(riotCookiesKey(key))
  try {
    return raw ? (JSON.parse(raw) as Record<string, string>) : null
  } catch {
    return null
  }
}

function loadRiotAccounts(): RiotAccountRecord[] {
  const raw = core.repos.meta.get(RIOT_ACCOUNTS_META)
  try {
    const list = raw ? (JSON.parse(raw) as RiotAccountRecord[]) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** Moves a v1.x single Riot account (riot.cookies + riot_account meta) into the multi-account list. */
function migrateSingleRiotAccount(): void {
  if (core.repos.meta.get(RIOT_ACCOUNTS_META)) return
  const legacy = secrets.get(LEGACY_RIOT_COOKIES_KEY)
  if (!legacy) return
  const acct = core.loadRiotAccount()
  const rec: RiotAccountRecord = {
    key: 'main',
    label: 'メイン',
    puuid: acct?.puuid ?? null,
    gameName: acct?.gameName ?? null,
    region: acct?.region ?? null,
    regionOverride: core.repos.settings.get().riotRegion,
    lastPeriodEnd: core.repos.monitor.get().lastPeriodEnd,
    createdAt: new Date().toISOString()
  }
  secrets.set(riotCookiesKey('main'), legacy)
  core.repos.meta.set(RIOT_ACCOUNTS_META, JSON.stringify([rec]))
  secrets.delete(LEGACY_RIOT_COOKIES_KEY)
  logger.info(`既存のRiotアカウントを引き継ぎました: ${accountDisplay(rec)}`)
}

function defaultLabel(): string {
  const n = riot.accounts().length
  return n === 0 ? 'メイン' : n === 1 ? 'サブ' : `アカウント${n + 1}`
}

async function afterRiotLogin(rec: RiotAccountRecord): Promise<unknown> {
  reloginNotified = false
  core.repos.monitor.set({ consecutiveFailures: 0, lastError: null, lastErrorAt: null })
  core.repos.settings.update({ providerId: 'riot' })
  logger.info(`Riotログイン成功: ${accountDisplay(rec)}`)
  broadcast()
  const r = await core.checkService.runCheck('manual')
  return { account: { key: rec.key, label: rec.label, gameName: rec.gameName, region: rec.region }, check: summarize(r) }
}

/** Opens the Riot login window (one at a time). `key` re-logs an existing account; otherwise a new one. */
function startRiotLogin(opts: { key?: string; label?: string } = {}): Promise<unknown> {
  if (!core.repos.settings.get().riskAcknowledged) return Promise.reject(new Error('先にリスクの確認をしてください'))
  if (loginInProgress) return loginInProgress
  if (!opts.key && riot.accounts().length >= MAX_RIOT_ACCOUNTS) return Promise.reject(new Error(`登録できるアカウントは${MAX_RIOT_ACCOUNTS}つまでです`))
  showWindow()
  loginInProgress = (async () => {
    const existing = opts.key ? riot.accounts().find((a) => a.key === opts.key) : null
    const key = opts.key ?? newAccountKey()
    const title = existing ? `再ログイン: ${accountDisplay(existing)}` : `${opts.label ?? defaultLabel()} のRiotログイン`
    const { redirectUrl, cookies } = await openRiotLoginWindow(mainWindow, key, loadRiotCookies(key), title)
    const rec = existing ? await riot.reloginFromLogin(key, redirectUrl, cookies) : await riot.addFromLogin(key, opts.label ?? defaultLabel(), redirectUrl, cookies)
    return afterRiotLogin(rec)
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
