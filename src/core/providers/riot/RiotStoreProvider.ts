import type { StoreSnapshot } from '../../types'
import { fetchWithTimeout, type FetchLike } from '../../util/http'
import { snapshotFromStorefront } from '../ManualImport'
import { ProviderUnavailableError, type ProviderContext, type ProviderStatus, type StoreProvider } from '../StoreProvider'
import {
  REGION_LABEL,
  RIOT_AUTHORIZE_URL,
  RIOT_CLIENT_PLATFORM,
  RIOT_ENTITLEMENTS_URL,
  RIOT_PAS_URL,
  RIOT_USERINFO_URL,
  shardForRegion,
  storefrontUrl
} from './constants'
import { applySetCookies, cookieHeader, type CookieJar } from './cookies'
import { decodeJwtPayload, parseTokenRedirect } from './tokens'

/** Result of GET /authorize without following the redirect. */
export interface AuthorizeResult {
  status: number
  location: string | null
  setCookies: string[]
}

/**
 * Transport for the one request that must NOT follow redirects.
 * Electron: net.request with redirect:'manual'. Node/tests: fetch with redirect:'manual'.
 */
export type AuthorizeFn = (url: string, cookie: string) => Promise<AuthorizeResult>

export class RiotAuthRequiredError extends Error {
  constructor(message = 'Riotへの再ログインが必要です（ログイン情報の有効期限切れ）。設定画面からログインし直してください。') {
    super(message)
    this.name = 'RiotAuthRequiredError'
  }
}

export interface RiotAccountInfo {
  puuid: string
  gameName: string | null
  region: string | null
}

export interface RiotProviderDeps {
  fetchImpl: FetchLike
  authorize: AuthorizeFn
  /** Encrypted cookie storage (returns null when logged out). */
  loadCookies: () => CookieJar | null
  saveCookies: (jar: CookieJar) => void
  /** Non-secret account info persisted in the DB. */
  loadAccount: () => RiotAccountInfo | null
  saveAccount: (a: RiotAccountInfo | null) => void
  getRegionSetting: () => string // 'auto' | region
  getClientVersion: () => Promise<string>
  riskAcknowledged: () => boolean
  /**
   * Optional: re-login WITHOUT user interaction by reusing Riot's own browser session
   * (the persistent login window). Returns null when Riot asks for credentials.
   */
  silentRelogin?: () => Promise<{ redirectUrl: string; cookies: CookieJar } | null>
  now?: () => Date
  timeoutMs?: number
}

interface Session {
  accessToken: string
  idToken: string | null
  entitlements: string
  expiresAt: number
}

/**
 * UNOFFICIAL provider: reads the user's own daily store using the session cookie
 * Riot issues after the user logs in on Riot's own login page.
 * - never sees or stores the password; MFA/CAPTCHA are completed by the user on Riot's page
 * - only the auth.riotgames.com cookies are stored (encrypted by the caller)
 */
export class RiotStoreProvider implements StoreProvider {
  readonly id = 'riot'
  readonly displayName = 'Riotアカウント（非公式・自分のストア）'
  readonly supportsAutomatic = true
  readonly usesUnofficialRiotApi = true
  private session: Session | null = null
  private lastAuthAt = 0
  /** Set when Riot rejected the saved cookie; no more auth requests until the user logs in again. */
  private authBroken = false
  private lastAuthOkAt = 0
  private lastSilentAt = 0

  constructor(private deps: RiotProviderDeps) {}

  private now(): number {
    return (this.deps.now?.() ?? new Date()).getTime()
  }

  get loggedIn(): boolean {
    return !!this.deps.loadCookies()?.ssid
  }

  async status(): Promise<ProviderStatus> {
    if (!this.deps.riskAcknowledged()) return { ready: false, message: 'リスクの確認が必要です（設定 → Riotアカウント連携）' }
    if (!this.loggedIn) return { ready: false, message: '未ログインです。設定画面から Riot にログインしてください。' }
    if (this.authBroken) return { ready: false, message: 'ログインの有効期限が切れました。設定画面から再ログインしてください。' }
    const a = this.deps.loadAccount()
    const region = a?.region ? (REGION_LABEL[a.region] ?? a.region) : '地域未確認'
    return { ready: true, message: `ログイン済み: ${a?.gameName ?? '（初回取得前）'} / ${region}`, accountLabel: a?.gameName ?? null }
  }

  /** Clears in-memory tokens (used on logout). */
  reset(): void {
    this.session = null
    this.authBroken = false
    this.lastAuthAt = 0
    this.lastSilentAt = 0
  }

  get needsRelogin(): boolean {
    return this.authBroken
  }

  canRunAutomatically(): boolean {
    return this.deps.riskAcknowledged() && this.loggedIn && !this.authBroken
  }

  /**
   * Keeps the Riot session alive: re-authenticates with the cookie when the last successful
   * auth is older than `maxAgeMs`, so Riot keeps rotating/extending the ssid cookie.
   * Returns true if a refresh happened.
   */
  async keepAlive(maxAgeMs = 12 * 3600_000): Promise<boolean> {
    if (!this.canRunAutomatically()) return false
    if (this.lastAuthOkAt && this.now() - this.lastAuthOkAt < maxAgeMs) return false
    await this.ensureSession(true)
    return true
  }

  /** Completes a fresh login from the opt_in redirect + cookies captured by the login window. */
  async completeLogin(redirectUrl: string, jar: CookieJar): Promise<RiotAccountInfo> {
    const t = parseTokenRedirect(redirectUrl)
    if (!t) throw new Error('ログイン結果からトークンを取得できませんでした')
    this.reset()
    if (!jar.ssid) throw new Error('ログインCookie (ssid) を取得できませんでした')
    this.deps.saveCookies(jar)
    this.deps.saveAccount(null)
    await this.establish(t.accessToken, t.idToken, t.expiresIn)
    this.lastAuthOkAt = this.now()
    return this.deps.loadAccount()!
  }

  /** Login by pasting an ssid cookie value (fallback when the embedded login window is blocked). */
  async loginWithSsid(ssid: string): Promise<RiotAccountInfo> {
    this.reset()
    const jar: CookieJar = { ssid }
    const res = await this.reauthWith(jar)
    this.deps.saveCookies(res.jar)
    this.deps.saveAccount(null)
    await this.establish(res.accessToken, res.idToken, res.expiresIn)
    this.lastAuthOkAt = this.now()
    return this.deps.loadAccount()!
  }

  private async reauthWith(jar: CookieJar): Promise<{ jar: CookieJar; accessToken: string; idToken: string | null; expiresIn: number }> {
    // throttle cookie re-auth (Riot rate-limits auth.riotgames.com)
    if (this.now() - this.lastAuthAt < 15_000) throw new Error('認証リクエストの間隔が短すぎます。しばらく待ってから再試行してください。')
    this.lastAuthAt = this.now()
    const r = await this.deps.authorize(RIOT_AUTHORIZE_URL, cookieHeader(jar))
    if (r.status === 429) throw new Error('Riot認証サーバーのレート制限中です。しばらく待ってから再試行されます。')
    const newJar = applySetCookies(jar, r.setCookies)
    const t = r.location ? parseTokenRedirect(r.location) : null
    if (t) return { jar: newJar, ...t }
    // Riot answered "please log in" (redirect to the login page, or the login page itself)
    const askedForLogin = (r.status >= 300 && r.status < 400 && !!r.location) || r.status === 200
    if (!askedForLogin) throw new Error(`Riot認証サーバーが一時的に応答しません (HTTP ${r.status})。時間をおいて再試行します。`)
    throw new RiotAuthRequiredError()
  }

  /** Builds a session from an access token: entitlements, account info and region. */
  private async establish(accessToken: string, idToken: string | null, expiresIn: number): Promise<void> {
    const auth = { Authorization: `Bearer ${accessToken}` }
    const ent = await this.json<{ entitlements_token?: string }>(RIOT_ENTITLEMENTS_URL, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' }, 'エンタイトルメント取得')
    if (!ent.entitlements_token) throw new Error('エンタイトルメントトークンを取得できませんでした')
    const payload = decodeJwtPayload(accessToken)
    const expFromJwt = typeof payload?.exp === 'number' ? payload.exp * 1000 : 0
    this.session = {
      accessToken,
      idToken,
      entitlements: ent.entitlements_token,
      expiresAt: expFromJwt || this.now() + expiresIn * 1000
    }
    let account = this.deps.loadAccount()
    const sub = typeof payload?.sub === 'string' ? payload.sub : null
    if (!account || (sub && account.puuid !== sub) || !account.gameName) {
      const info = await this.json<{ sub?: string; acct?: { game_name?: string; tag_line?: string } }>(RIOT_USERINFO_URL, { headers: auth }, 'アカウント情報取得')
      const puuid = info.sub ?? sub
      if (!puuid) throw new Error('アカウントID (PUUID) を取得できませんでした')
      const name = info.acct?.game_name ? `${info.acct.game_name}#${info.acct.tag_line ?? ''}` : null
      account = { puuid, gameName: name, region: account?.puuid === puuid ? account.region : null }
    }
    if (!account.region && idToken) {
      try {
        const pas = await this.json<{ affinities?: { live?: string } }>(
          RIOT_PAS_URL,
          { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token: idToken }) },
          '地域の確認'
        )
        account = { ...account, region: pas.affinities?.live ?? null }
      } catch {
        /* region can also be set manually */
      }
    }
    this.deps.saveAccount(account)
  }

  private async ensureSession(force = false): Promise<Session> {
    if (!force && this.session && this.session.expiresAt - this.now() > 5 * 60_000) return this.session
    if (this.authBroken) throw new RiotAuthRequiredError()
    const jar = this.deps.loadCookies()
    if (!jar?.ssid) throw new RiotAuthRequiredError('Riotにログインしていません。設定画面からログインしてください。')
    try {
      const r = await this.reauthWith(jar)
      this.deps.saveCookies(r.jar) // Riot may rotate the ssid cookie
      await this.establish(r.accessToken, r.idToken, r.expiresIn)
    } catch (e) {
      if (!(e instanceof RiotAuthRequiredError)) throw e
      // cookie expired → try Riot's own remembered browser session before bothering the user
      if (!(await this.trySilentRelogin())) {
        this.authBroken = true
        throw e
      }
    }
    this.lastAuthOkAt = this.now()
    return this.session!
  }

  private async trySilentRelogin(): Promise<boolean> {
    if (!this.deps.silentRelogin || this.now() - this.lastSilentAt < 30 * 60_000) return false
    this.lastSilentAt = this.now()
    try {
      const res = await this.deps.silentRelogin()
      const t = res ? parseTokenRedirect(res.redirectUrl) : null
      if (!res || !t || !res.cookies.ssid) return false
      this.deps.saveCookies(res.cookies)
      await this.establish(t.accessToken, t.idToken, t.expiresIn)
      return true
    } catch {
      return false
    }
  }

  private region(): string {
    const setting = this.deps.getRegionSetting()
    if (setting && setting !== 'auto') return setting
    const r = this.deps.loadAccount()?.region
    if (!r) throw new ProviderUnavailableError('地域を自動判定できませんでした。設定画面で地域（例: AP）を選んでください。')
    return r
  }

  async fetchStore(_ctx: ProviderContext): Promise<StoreSnapshot> {
    if (!this.deps.riskAcknowledged()) throw new ProviderUnavailableError('非公式方式のリスク確認が完了していません')
    let session = await this.ensureSession()
    const doFetch = async (s: Session) => {
      const account = this.deps.loadAccount()!
      return fetchWithTimeout(
        this.deps.fetchImpl,
        storefrontUrl(shardForRegion(this.region()), account.puuid),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${s.accessToken}`,
            'X-Riot-Entitlements-JWT': s.entitlements,
            'X-Riot-ClientPlatform': RIOT_CLIENT_PLATFORM,
            'X-Riot-ClientVersion': await this.deps.getClientVersion(),
            'Content-Type': 'application/json'
          },
          body: '{}'
        },
        this.deps.timeoutMs ?? 20000
      )
    }
    let res = await doFetch(session)
    let body = await safeJson(res)
    if (res.status === 401 || (res.status === 400 && body?.errorCode === 'BAD_CLAIMS')) {
      session = await this.ensureSession(true) // token rejected → one silent re-auth
      res = await doFetch(session)
      body = await safeJson(res)
    }
    if (res.status === 403 && body?.errorCode === 'SCHEDULED_DOWNTIME') throw new Error('VALORANT がメンテナンス中です。時間をおいて再試行します。')
    if (res.status === 404) throw new Error('ストアが見つかりません。地域設定が正しいか確認してください。')
    if (res.status === 429) throw new Error('Riot APIのレート制限中です。時間をおいて再試行します。')
    if (!res.ok || !body) throw new Error(`ストア取得に失敗しました (HTTP ${res.status}${body?.errorCode ? ` ${String(body.errorCode)}` : ''})`)
    const account = this.deps.loadAccount()!
    return snapshotFromStorefront(body, new Date(this.now()), { accountId: account.puuid, accountName: account.gameName, source: this.id })
  }

  private async json<T>(url: string, init: RequestInit, label: string): Promise<T> {
    const res = await fetchWithTimeout(this.deps.fetchImpl, url, init, this.deps.timeoutMs ?? 20000)
    if (res.status === 401 || res.status === 403) throw new RiotAuthRequiredError()
    if (!res.ok) throw new Error(`${label}に失敗しました (HTTP ${res.status})`)
    return (await res.json()) as T
  }
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Node implementation of AuthorizeFn (headless runner / tests). */
export const nodeAuthorize =
  (fetchImpl: FetchLike): AuthorizeFn =>
  async (url, cookie) => {
    const res = await fetchWithTimeout(fetchImpl, url, { redirect: 'manual', headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' } }, 15000)
    const h = res.headers as Headers & { getSetCookie?: () => string[] }
    return { status: res.status, location: res.headers.get('location'), setCookies: h.getSetCookie?.() ?? [] }
  }
