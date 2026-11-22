import type { StoreSnapshot } from '../../types'
import type { FetchLike } from '../../util/http'
import { errorMessage } from '../../util/redact'
import { ProviderUnavailableError, type MultiFetchItem, type ProviderContext, type ProviderStatus, type StoreProvider } from '../StoreProvider'
import { REGION_LABEL } from './constants'
import type { CookieJar } from './cookies'
import { RiotAuthRequiredError, RiotStoreProvider, type AuthorizeFn } from './RiotStoreProvider'

/** One registered Riot account (non-secret data; cookies live in encrypted storage per key). */
export interface RiotAccountRecord {
  key: string
  label: string
  puuid: string | null
  gameName: string | null
  region: string | null
  /** 'auto' or a fixed region for this account. */
  regionOverride: string
  /** Store period end of the last successful fetch (skip refetching a fresh store). */
  lastPeriodEnd: string | null
  createdAt: string
}

export const MAX_RIOT_ACCOUNTS = 5

export interface RiotAccountsDeps {
  fetchImpl: FetchLike
  authorize: AuthorizeFn
  loadAccounts: () => RiotAccountRecord[]
  saveAccounts: (list: RiotAccountRecord[]) => void
  loadCookies: (key: string) => CookieJar | null
  saveCookies: (key: string, jar: CookieJar) => void
  deleteCookies: (key: string) => void
  getClientVersion: () => Promise<string>
  riskAcknowledged: () => boolean
  silentRelogin?: (key: string) => Promise<{ redirectUrl: string; cookies: CookieJar } | null>
  now?: () => Date
  /** Pause between accounts so requests are not fired in a burst. */
  sleepBetweenMs?: number
}

export class DuplicateRiotAccountError extends Error {
  constructor(name: string | null) {
    super(`このアカウント（${name ?? '登録済み'}）はすでに登録されています`)
    this.name = 'DuplicateRiotAccountError'
  }
}

/** Display name used in notifications, e.g. "Player#JP1（メイン）". */
export function accountDisplay(a: Pick<RiotAccountRecord, 'gameName' | 'label'>): string {
  if (a.gameName && a.label) return `${a.gameName}（${a.label}）`
  return a.gameName ?? a.label ?? 'Riotアカウント'
}

/**
 * Store provider for several Riot accounts owned by the same user (e.g. main + sub).
 * Each account has its own RiotStoreProvider (session, re-login, keep-alive) and its own
 * encrypted cookies. Accounts are checked one after another, never in parallel.
 */
export class RiotAccountsProvider implements StoreProvider {
  readonly id = 'riot'
  readonly displayName = 'Riotアカウント（非公式・自分のストア）'
  readonly supportsAutomatic = true
  readonly usesUnofficialRiotApi = true
  private providers = new Map<string, RiotStoreProvider>()

  constructor(private deps: RiotAccountsDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  accounts(): RiotAccountRecord[] {
    return this.deps.loadAccounts()
  }

  private update(key: string, patch: Partial<RiotAccountRecord>): void {
    const list = this.accounts().map((a) => (a.key === key ? { ...a, ...patch } : a))
    this.deps.saveAccounts(list)
  }

  private record(key: string): RiotAccountRecord | undefined {
    return this.accounts().find((a) => a.key === key)
  }

  /** The single-account provider for `key` (created on demand). */
  provider(key: string): RiotStoreProvider {
    let p = this.providers.get(key)
    if (!p) {
      p = new RiotStoreProvider({
        fetchImpl: this.deps.fetchImpl,
        authorize: this.deps.authorize,
        loadCookies: () => this.deps.loadCookies(key),
        saveCookies: (jar) => this.deps.saveCookies(key, jar),
        loadAccount: () => {
          const r = this.record(key)
          return r?.puuid ? { puuid: r.puuid, gameName: r.gameName, region: r.region } : null
        },
        saveAccount: (a) => this.update(key, a ? { puuid: a.puuid, gameName: a.gameName, region: a.region } : { puuid: null, gameName: null, region: null }),
        getRegionSetting: () => this.record(key)?.regionOverride ?? 'auto',
        getClientVersion: this.deps.getClientVersion,
        riskAcknowledged: this.deps.riskAcknowledged,
        silentRelogin: this.deps.silentRelogin ? () => this.deps.silentRelogin!(key) : undefined,
        now: this.deps.now
      })
      this.providers.set(key, p)
    }
    return p
  }

  isLoggedIn(key: string): boolean {
    return !!this.deps.loadCookies(key)?.ssid
  }

  needsRelogin(key: string): boolean {
    return this.provider(key).needsRelogin
  }

  private ready(key: string): boolean {
    return this.isLoggedIn(key) && !this.needsRelogin(key)
  }

  get loggedIn(): boolean {
    return this.accounts().some((a) => this.isLoggedIn(a.key))
  }

  /** At least one account needs a manual re-login. */
  get anyNeedsRelogin(): boolean {
    return this.accounts().some((a) => this.isLoggedIn(a.key) && this.needsRelogin(a.key))
  }

  canRunAutomatically(): boolean {
    return this.deps.riskAcknowledged() && this.accounts().some((a) => this.ready(a.key))
  }

  async status(): Promise<ProviderStatus> {
    if (!this.deps.riskAcknowledged()) return { ready: false, message: 'リスクの確認が必要です（設定 → Riotアカウント連携）' }
    const list = this.accounts()
    if (!list.length || !this.loggedIn) return { ready: false, message: '未ログインです。設定画面から Riot にログインしてください。' }
    const ok = list.filter((a) => this.ready(a.key))
    if (!ok.length) return { ready: false, message: 'ログインの有効期限が切れました。設定画面から再ログインしてください。' }
    const parts = list.map((a) => `${accountDisplay(a)}${this.ready(a.key) ? '' : this.isLoggedIn(a.key) ? '（要再ログイン）' : '（未ログイン）'}`)
    const region = ok[0].region ? (REGION_LABEL[ok[0].region] ?? ok[0].region) : '地域未確認'
    return { ready: true, message: `ログイン済み: ${parts.join(' / ')}${list.length === 1 ? ` / ${region}` : ''}`, accountLabel: ok.map((a) => a.gameName ?? a.label).join(', ') }
  }

  /** Registers a NEW account from the login window result. */
  async addFromLogin(key: string, label: string, redirectUrl: string, jar: CookieJar): Promise<RiotAccountRecord> {
    const list = this.accounts()
    if (list.length >= MAX_RIOT_ACCOUNTS) throw new Error(`登録できるアカウントは${MAX_RIOT_ACCOUNTS}つまでです`)
    this.deps.saveAccounts([...list, newRecord(key, label, this.now())])
    try {
      await this.provider(key).completeLogin(redirectUrl, jar)
      this.assertUnique(key)
      return this.record(key)!
    } catch (e) {
      this.removeLocal(key)
      throw e
    }
  }

  /** Registers a NEW account from a pasted ssid. */
  async addFromSsid(key: string, label: string, ssid: string): Promise<RiotAccountRecord> {
    const list = this.accounts()
    if (list.length >= MAX_RIOT_ACCOUNTS) throw new Error(`登録できるアカウントは${MAX_RIOT_ACCOUNTS}つまでです`)
    this.deps.saveAccounts([...list, newRecord(key, label, this.now())])
    try {
      await this.provider(key).loginWithSsid(ssid)
      this.assertUnique(key)
      return this.record(key)!
    } catch (e) {
      this.removeLocal(key)
      throw e
    }
  }

  /** Re-login of an EXISTING account; refuses a different Riot account. */
  async reloginFromLogin(key: string, redirectUrl: string, jar: CookieJar): Promise<RiotAccountRecord> {
    const before = this.record(key)
    if (!before) throw new Error('アカウントが見つかりません')
    await this.provider(key).completeLogin(redirectUrl, jar)
    this.checkSameAccount(key, before)
    this.assertUnique(key)
    return this.record(key)!
  }

  async reloginFromSsid(key: string, ssid: string): Promise<RiotAccountRecord> {
    const before = this.record(key)
    if (!before) throw new Error('アカウントが見つかりません')
    await this.provider(key).loginWithSsid(ssid)
    this.checkSameAccount(key, before)
    this.assertUnique(key)
    return this.record(key)!
  }

  private checkSameAccount(key: string, before: RiotAccountRecord): void {
    const after = this.record(key)
    if (before.puuid && after?.puuid && before.puuid !== after.puuid) {
      // restore the previous identity; the cookies belong to another account → drop them
      this.deps.deleteCookies(key)
      this.update(key, { puuid: before.puuid, gameName: before.gameName, region: before.region })
      this.provider(key).reset()
      throw new Error(`別のアカウント（${after.gameName ?? '不明'}）でログインしました。「${accountDisplay(before)}」でログインし直してください。`)
    }
  }

  private assertUnique(key: string): void {
    const me = this.record(key)
    if (!me?.puuid) return
    const dup = this.accounts().find((a) => a.key !== key && a.puuid === me.puuid)
    if (dup) {
      this.removeLocal(key)
      throw new DuplicateRiotAccountError(dup.gameName)
    }
  }

  rename(key: string, label: string): void {
    this.update(key, { label: label.trim().slice(0, 20) || 'アカウント' })
  }

  setRegion(key: string, region: string): void {
    this.update(key, { regionOverride: region })
  }

  /** Removes the account and all its stored credentials (caller wipes the browser session). */
  remove(key: string): void {
    this.removeLocal(key)
  }

  private removeLocal(key: string): void {
    this.deps.deleteCookies(key)
    this.providers.get(key)?.reset()
    this.providers.delete(key)
    this.deps.saveAccounts(this.accounts().filter((a) => a.key !== key))
  }

  /** Refreshes every account's session that is older than 12h (keeps saved logins alive). */
  async keepAlive(): Promise<string[]> {
    const refreshed: string[] = []
    for (const a of this.accounts()) {
      if (!this.ready(a.key)) continue
      try {
        if (await this.provider(a.key).keepAlive()) refreshed.push(accountDisplay(a))
      } catch {
        /* reported on the next store check */
      }
    }
    return refreshed
  }

  /** Single-store API (used only when one snapshot is expected): the first ready account. */
  async fetchStore(ctx: ProviderContext): Promise<StoreSnapshot> {
    const first = this.accounts().find((a) => this.ready(a.key))
    if (!first) throw new RiotAuthRequiredError('Riotにログインしていません。設定画面からログインしてください。')
    return this.provider(first.key).fetchStore(ctx)
  }

  /**
   * Fetches the store of every account, one after another.
   * Accounts whose store for the current period was already fetched are skipped unless `force`.
   */
  async fetchStores(ctx: ProviderContext, opts: { force: boolean }): Promise<MultiFetchItem[]> {
    if (!this.deps.riskAcknowledged()) throw new ProviderUnavailableError('非公式方式のリスク確認が完了していません')
    const list = this.accounts()
    if (!list.length) throw new RiotAuthRequiredError('Riotにログインしていません。設定画面からログインしてください。')
    const out: MultiFetchItem[] = []
    let first = true
    for (const a of list) {
      const label = accountDisplay(a)
      if (!this.isLoggedIn(a.key)) {
        out.push({ key: a.key, label, skipped: 'not-logged-in' })
        continue
      }
      if (this.needsRelogin(a.key)) {
        out.push({ key: a.key, label, skipped: 'relogin' })
        continue
      }
      if (!opts.force && a.lastPeriodEnd && new Date(a.lastPeriodEnd).getTime() > this.now().getTime()) {
        out.push({ key: a.key, label, skipped: 'fresh' })
        continue
      }
      if (!first && this.deps.sleepBetweenMs) await new Promise((r) => setTimeout(r, this.deps.sleepBetweenMs))
      first = false
      try {
        const snapshot = await this.provider(a.key).fetchStore(ctx)
        this.update(a.key, { lastPeriodEnd: snapshot.periodEnd ?? null })
        out.push({ key: a.key, label: accountDisplay(this.record(a.key) ?? a), snapshot })
      } catch (e) {
        const relogin = e instanceof RiotAuthRequiredError
        out.push({ key: a.key, label, error: errorMessage(e), relogin })
      }
    }
    return out
  }
}

function newRecord(key: string, label: string, now: Date): RiotAccountRecord {
  return { key, label: label.trim().slice(0, 20) || 'アカウント', puuid: null, gameName: null, region: null, regionOverride: 'auto', lastPeriodEnd: null, createdAt: now.toISOString() }
}

/** New unique account key. */
export function newAccountKey(now = new Date()): string {
  return `a${now.getTime().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}
