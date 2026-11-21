import { app, BrowserWindow, net, session, shell, type Session } from 'electron'
import { RIOT_AUTHORIZE_URL, RIOT_REDIRECT_PREFIX, type AuthorizeFn, type CookieJar } from '../core'

/** Chrome-like UA without the "Electron/x" token (Riot's login page is a normal web page). */
export function browserUserAgent(): string {
  return app.userAgentFallback.replace(/\sElectron\/\S+/, '').replace(/\svalorant-store-watcher\/\S+/i, '')
}

let apiSession: Session | null = null
function riotApiSession(): Session {
  // in-memory, isolated session: never shares cookies with the app or the login window
  apiSession ??= session.fromPartition('vsw-riot-api')
  return apiSession
}

/** GET /authorize with the saved cookies WITHOUT following the redirect (Electron net stack, honors system proxy). */
export const electronAuthorize: AuthorizeFn = (url, cookie) =>
  new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', redirect: 'manual', useSessionCookies: false, session: riotApiSession() })
    req.setHeader('Cookie', cookie)
    req.setHeader('User-Agent', browserUserAgent())
    const timer = setTimeout(() => {
      req.abort()
      reject(new Error('Riot認証サーバーへの接続がタイムアウトしました'))
    }, 15000)
    const done = (v: Parameters<typeof resolve>[0]) => {
      clearTimeout(timer)
      resolve(v)
    }
    req.on('redirect', (statusCode, _method, redirectUrl, headers) => {
      const loc = (headers['location'] ?? headers['Location'])?.[0] ?? redirectUrl
      done({ status: statusCode, location: loc ? new URL(loc, url).toString() : null, setCookies: headers['set-cookie'] ?? [] })
      req.abort()
    })
    req.on('response', (res) => {
      const h = res.headers as Record<string, string | string[]>
      const sc = h['set-cookie']
      done({ status: res.statusCode, location: null, setCookies: Array.isArray(sc) ? sc : sc ? [sc] : [] })
      res.on('data', () => undefined)
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    req.end()
  })

/**
 * Riot's own browser session for the login window. Persisted (Chromium cookie store,
 * encrypted with DPAPI via the EnableCookieEncryption fuse) so that Riot's
 * "stay signed in" / trusted-device state survives and re-login is usually one click
 * or fully silent. Wiped on logout.
 */
const LOGIN_PARTITION = 'persist:riot-login'
function loginSession(): Session {
  const ses = session.fromPartition(LOGIN_PARTITION)
  ses.setUserAgent(browserUserAgent())
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  return ses
}

async function captureCookies(ses: Session): Promise<CookieJar> {
  const list = await ses.cookies.get({ url: 'https://auth.riotgames.com/' })
  const cookies: CookieJar = {}
  for (const c of list) cookies[c.name] = c.value
  return cookies
}

/**
 * Puts the app's saved (DPAPI-encrypted) Riot cookies back into the login browser session,
 * so Riot sees the same signed-in state even if its session cookies were dropped on restart.
 */
async function restoreCookies(ses: Session, jar: CookieJar | null): Promise<void> {
  if (!jar) return
  const existing = new Set((await ses.cookies.get({ url: 'https://auth.riotgames.com/' })).map((c) => c.name))
  const expirationDate = Math.floor(Date.now() / 1000) + 30 * 86400
  for (const [name, value] of Object.entries(jar)) {
    if (existing.has(name) && name !== 'ssid') continue
    await ses.cookies
      .set({ url: 'https://auth.riotgames.com/', name, value, secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate })
      .catch(() => undefined)
  }
}

/**
 * Tries to log in WITHOUT any user interaction: loads Riot's authorize page in a hidden window
 * using the remembered Riot browser session. If Riot redirects straight to opt_in, the new token
 * and cookies are returned; if Riot shows its login form, returns null (the user must log in).
 * Nothing is typed or clicked automatically.
 */
export function silentRiotLogin(saved: CookieJar | null, timeoutMs = 25_000): Promise<{ redirectUrl: string; cookies: CookieJar } | null> {
  return new Promise((resolve) => void restoreCookies(loginSession(), saved).finally(() => run(resolve)))
  function run(resolve: (v: { redirectUrl: string; cookies: CookieJar } | null) => void): void {
    const ses = loginSession()
    const win = new BrowserWindow({
      show: false,
      width: 480,
      height: 720,
      webPreferences: { partition: LOGIN_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    let done = false
    const finish = async (url: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(settle)
      const res = url ? { redirectUrl: url, cookies: await captureCookies(ses) } : null
      if (!win.isDestroyed()) win.destroy()
      resolve(res)
    }
    const timer = setTimeout(() => void finish(null), timeoutMs)
    let settle: NodeJS.Timeout | undefined
    const check = (e: { preventDefault: () => void } | null, url: string) => {
      if (url.startsWith(RIOT_REDIRECT_PREFIX)) {
        e?.preventDefault()
        void finish(url)
      }
    }
    win.webContents.on('will-redirect', (e) => check(e, e.url))
    win.webContents.on('will-navigate', (e) => check(e, e.url))
    win.webContents.on('did-navigate', (_e, url) => check(null, url))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // the login form stayed on screen → Riot wants credentials; give scripted redirects a few seconds
    win.webContents.on('did-finish-load', () => {
      clearTimeout(settle)
      settle = setTimeout(() => void finish(null), 6000)
    })
    void win.loadURL(RIOT_AUTHORIZE_URL).catch(() => void finish(null))
  }
}

/**
 * Opens Riot's OWN login page in an isolated browser session.
 * The user types credentials / MFA / CAPTCHA directly into Riot's page; this app injects
 * no script and never reads the form. When Riot redirects to playvalorant.com/opt_in,
 * the token URL and the auth.riotgames.com cookies are captured and the session is wiped.
 */
export async function openRiotLoginWindow(parent: BrowserWindow | null, saved: CookieJar | null = null): Promise<{ redirectUrl: string; cookies: CookieJar }> {
  await restoreCookies(loginSession(), saved)
  return new Promise((resolve, reject) => {
    const partition = LOGIN_PARTITION
    const ses = loginSession()
    const win = new BrowserWindow({
      width: 520,
      height: 780,
      parent: parent ?? undefined,
      modal: false,
      title: 'Riotにログイン',
      autoHideMenuBar: true,
      backgroundColor: '#111111',
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
    })
    let finished = false
    const finish = async (err: Error | null, redirectUrl?: string) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      try {
        if (!err && redirectUrl) resolve({ redirectUrl, cookies: await captureCookies(ses) })
        else reject(err ?? new Error('ログインに失敗しました'))
      } finally {
        // Riot's session is kept (encrypted) for one-click / silent re-login; wiped on logout
        if (!win.isDestroyed()) win.destroy()
      }
    }
    const timeout = setTimeout(() => void finish(new Error('ログインがタイムアウトしました（10分）')), 10 * 60_000)
    const check = (e: { preventDefault: () => void } | null, url: string) => {
      if (url.startsWith(RIOT_REDIRECT_PREFIX)) {
        e?.preventDefault()
        void finish(null, url)
        return
      }
      if (!url.startsWith('https://')) e?.preventDefault()
    }
    win.webContents.on('will-redirect', (e) => check(e, e.url))
    win.webContents.on('will-navigate', (e) => check(e, e.url))
    win.webContents.on('did-navigate', (_e, url) => check(null, url))
    win.webContents.on('did-navigate-in-page', (_e, url) => check(null, url))
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\/([\w-]+\.)*riotgames\.com\//.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // show the real host in the title so the user can verify they are on Riot's page
    win.on('page-title-updated', (e) => {
      e.preventDefault()
      try {
        const host = new URL(win.webContents.getURL()).host
        win.setTitle(`🔒 ${host} — Riot公式ログインページ`)
      } catch {
        /* ignore */
      }
    })
    win.on('closed', () => void finish(new Error('ログインがキャンセルされました')))
    void win.loadURL(RIOT_AUTHORIZE_URL)
  })
}

export async function wipeRiotSessions(): Promise<void> {
  await riotApiSession().clearStorageData().catch(() => undefined)
  await session.fromPartition(LOGIN_PARTITION).clearStorageData().catch(() => undefined)
}
