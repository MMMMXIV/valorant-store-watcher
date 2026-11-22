import type { Repos } from '../db/repositories'
import {
  buildDailyPayload,
  buildErrorPayload,
  buildTestPayload,
  buildWishlistPayloads,
  sendWebhook,
  type DiscordPayload,
  type SendOptions
} from '../notify/discord'
import { isMultiStoreProvider, type ProviderContext, type StoreProvider } from '../providers/StoreProvider'
import { computePeriodKey } from '../providers/period'
import type { CheckTrigger, MatchResult, StoredSnapshot, StoreSnapshot } from '../types'
import type { Settings } from '../settings'
import type { FetchLike } from '../util/http'
import { errorMessage } from '../util/redact'
import { formatZonedDate } from '../util/time'
import { matchWishlist, resolveOffers } from './matcher'

export interface CheckResult {
  status: 'success' | 'error' | 'skipped'
  message: string
  snapshot: StoredSnapshot | null
  matches: MatchResult[]
  notified: number
  failedNotifications: number
  /** Windows toast notifications the main process should show for this run (already deduped). */
  desktop: DesktopNotice[]
}

export interface DesktopNotice {
  kind: 'wishlist' | 'store'
  title: string
  body: string
}

/** A destination that can deliver a Discord message (Webhook channel or BOT DM). */
export interface Notifier {
  kind: 'webhook' | 'bot'
  send(payload: DiscordPayload): Promise<{ attempts: number }>
}

export interface CheckServiceDeps {
  repos: Repos
  getProvider: () => StoreProvider
  getWebhookUrl: () => Promise<string | null>
  /** Optional: overrides the webhook (e.g. BOT DM). Returns null when not configured. */
  getNotifier?: () => Promise<Notifier | null>
  fetchImpl: FetchLike
  now?: () => Date
  sendOptions?: SendOptions
  onChange?: () => void
  /** Fired after each completed run (used to show Windows toast notifications). */
  onResult?: (r: CheckResult, trigger: CheckTrigger) => void
}

/**
 * The full check pipeline, independent from Electron/UI so it can run headless:
 * fetch → normalize ids → match wishlist → dedupe against history → notify → persist.
 */
export class StoreCheckService {
  private running: Promise<CheckResult> | null = null

  constructor(private deps: CheckServiceDeps) {}

  get isRunning(): boolean {
    return this.running !== null
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  providerContext(): ProviderContext {
    return { now: this.now(), catalog: () => this.deps.repos.catalog.allSkins(), wishlist: () => this.deps.repos.wishlist.list() }
  }

  /** Single-flight: concurrent calls share the same run (prevents double notifications). */
  runCheck(trigger: CheckTrigger, imported?: StoreSnapshot): Promise<CheckResult> {
    if (!this.running) {
      this.running = this.doRun(trigger, imported)
        .then((r) => {
          try {
            this.deps.onResult?.(r, trigger)
          } catch {
            /* a notification failure must never break the check */
          }
          return r
        })
        .finally(() => {
          this.running = null
          this.deps.onChange?.()
        })
    }
    return this.running
  }

  /**
   * Builds the Windows toast notices for a run, deduplicated per store period so repeated
   * checks on the same day never re-notify. Records them immediately (kinds desktop-wishlist / desktop-store).
   */
  private buildDesktop(accountId: string, periodKey: string, matches: MatchResult[], storeCount: number, settings: Settings, accountLabel?: string | null): DesktopNotice[] {
    const out: DesktopNotice[] = []
    const now = () => this.now().toISOString()
    if (settings.desktopNotifyWishlist) {
      const fresh = matches.filter((m) => !this.deps.repos.notifications.wasSent(accountId, periodKey, m.offer.skinId!, 'desktop-wishlist'))
      for (const m of fresh) this.deps.repos.notifications.record(accountId, periodKey, m.offer.skinId!, 'desktop-wishlist', true, 0, null)
      if (fresh.length) {
        const names = fresh.map((m) => m.offer.skin?.nameJa ?? '不明なスキン')
        const who = accountLabel ? `${accountLabel}: ` : ''
        out.push({
          kind: 'wishlist',
          title: '🎯 ウィッシュリストのスキンがストアに登場！',
          body: who + (names.length === 1 ? `${names[0]} が今日のストアにあります` : `${names.slice(0, 3).join('、')}${names.length > 3 ? ` ほか${names.length - 3}件` : ''} が今日のストアにあります`)
        })
      }
    }
    if (settings.desktopNotifyStore && !this.deps.repos.notifications.wasSent(accountId, periodKey, '', 'desktop-store')) {
      this.deps.repos.notifications.record(accountId, periodKey, '', 'desktop-store', true, 0, null)
      void now()
      const who = accountLabel ? `${accountLabel}: ` : ''
      out.push({
        kind: 'store',
        title: '🛒 本日のストアを取得しました',
        body: who + (matches.length ? `ウィッシュリスト ${matches.length}件が登場中（全${storeCount}スキン）` : `本日のストア ${storeCount}スキンを確認しました`)
      })
    }
    return out
  }

  /** Runs the notify/save/dedupe pipeline for one store snapshot (one account). */
  private async processSnapshot(
    snap: StoreSnapshot,
    settings: Settings,
    webhook: Notifier | null,
    accountLabel: string | null,
    multi: boolean
  ): Promise<{ matches: MatchResult[]; notified: number; failed: number; unresolved: number; stored: StoredSnapshot | null; desktop: DesktopNotice[] }> {
    const { repos } = this.deps
    const offers = resolveOffers(snap, repos.catalog)
    const periodKey = computePeriodKey(snap)
    const snapshotId = repos.stores.save(
      {
        accountId: snap.accountId,
        accountName: snap.accountName ?? accountLabel,
        periodKey,
        periodStart: snap.periodStart ?? null,
        periodEnd: snap.periodEnd ?? null,
        fetchedAt: snap.fetchedAt,
        source: snap.source
      },
      offers
    )
    const stored = repos.stores.list(400).find((s) => s.id === snapshotId) ?? null
    const matches = matchWishlist(offers, repos.wishlist.list())
    const periodDate = new Date(snap.periodStart ?? (snap.periodEnd ? new Date(new Date(snap.periodEnd).getTime() - 86_400_000) : snap.fetchedAt))
    const label = multi ? accountLabel : null
    let notified = 0
    let failed = 0

    if (webhook && settings.notifyWishlist) {
      const pending = matches.filter((m) => !repos.notifications.wasSent(snap.accountId, periodKey, m.offer.skinId!, 'wishlist'))
      for (const { payload, skinIds } of buildWishlistPayloads(pending, settings.timezone, periodDate, label)) {
        const r = await this.trySend(webhook, payload)
        for (const id of skinIds) repos.notifications.record(snap.accountId, periodKey, id, 'wishlist', r.ok, r.attempts, r.error)
        if (r.ok) notified += skinIds.length
        else failed += skinIds.length
      }
    }
    if (webhook && settings.notifyDailyStore && !repos.notifications.wasSent(snap.accountId, periodKey, '', 'daily')) {
      const r = await this.trySend(webhook, buildDailyPayload(offers, settings.timezone, periodDate, new Set(matches.map((m) => m.offer.skinId!)), label))
      repos.notifications.record(snap.accountId, periodKey, '', 'daily', r.ok, r.attempts, r.error)
      if (!r.ok) failed++
    }
    const desktop = this.buildDesktop(snap.accountId, periodKey, matches, offers.length, settings, label)
    return { matches, notified, failed, unresolved: offers.filter((o) => !o.skinId).length, stored, desktop }
  }

  private async doRun(trigger: CheckTrigger, imported?: StoreSnapshot): Promise<CheckResult> {
    const { repos } = this.deps
    const provider = this.deps.getProvider()
    const settings = repos.settings.get()
    const runId = repos.runs.start(trigger, imported ? imported.source : provider.id)
    this.deps.repos.monitor.set({ lastAttemptAt: this.now().toISOString() })
    const webhook = settings.notificationsEnabled ? await this.notifier() : null
    const tz = settings.timezone

    // Multi-account path: several Riot accounts, one after another. One account's failure
    // never stops the others; the run succeeds if at least one account was fetched.
    if (!imported && isMultiStoreProvider(provider) && provider.fetchStores) {
      try {
        const items = await provider.fetchStores(this.providerContext(), { force: trigger === 'manual' })
        const fetched = items.filter((i) => i.snapshot)
        const reloginAccounts = items.filter((i) => i.relogin || i.skipped === 'relogin').map((i) => i.label)
        const errored = items.filter((i) => i.error && !i.relogin)
        if (!fetched.length) {
          // nothing fetched → treat as an error run so the scheduler retries / asks for re-login
          const why = reloginAccounts.length ? `再ログインが必要: ${reloginAccounts.join('、')}` : errored.length ? (errored[0].error ?? 'ストア取得に失敗しました') : 'ログイン済みのアカウントがありません'
          throw new Error(why)
        }
        let totalMatched = 0
        let totalNotified = 0
        let totalFailed = 0
        let totalUnresolved = 0
        const allMatches: MatchResult[] = []
        const allDesktop: DesktopNotice[] = []
        let firstStored: StoredSnapshot | null = null
        let periodEnd: string | null = null
        let periodKey: string | null = null
        for (const item of fetched) {
          const snap = item.snapshot!
          if (!snap.offers.length) continue
          const res = await this.processSnapshot(snap, settings, webhook, item.label, items.length > 1)
          totalMatched += res.matches.length
          totalNotified += res.notified
          totalFailed += res.failed
          totalUnresolved += res.unresolved
          allMatches.push(...res.matches)
          allDesktop.push(...res.desktop)
          firstStored ??= res.stored
          periodEnd ??= snap.periodEnd ?? null
          periodKey ??= computePeriodKey(snap)
        }
        const parts = [`取得 ${fetched.length}アカウント`, `一致 ${totalMatched}件`, `新規通知 ${totalNotified}件`]
        if (totalFailed) parts.push(`通知失敗 ${totalFailed}件`)
        if (reloginAccounts.length) parts.push(`要再ログイン ${reloginAccounts.length}件`)
        if (errored.length) parts.push(`取得失敗 ${errored.length}件`)
        if (totalUnresolved) parts.push(`カタログ未登録 ${totalUnresolved}件`)
        if (!webhook && settings.notificationsEnabled && totalMatched) parts.push('通知先が未設定のため通知なし')
        const message = parts.join(' / ')
        repos.runs.finish(runId, { status: 'success', periodKey, matched: totalMatched, notified: totalNotified, message })
        const lastErr =
          reloginAccounts.length ? `再ログインが必要なアカウントがあります: ${reloginAccounts.join('、')}` : totalFailed ? `Discord 通知に失敗しました (${totalFailed}件) — 次回チェック時に再送します` : errored.length ? `一部のアカウントで取得に失敗しました（${errored.length}件）` : null
        // a temporary failure of one account → keep the retry schedule running for it
        // (accounts already fetched for this period are skipped on the retry)
        const prevFails = repos.monitor.get().consecutiveFailures
        repos.monitor.set({
          lastSuccessAt: this.now().toISOString(),
          lastPeriodKey: periodKey,
          lastPeriodEnd: periodEnd,
          consecutiveFailures: errored.length ? prevFails + 1 : 0,
          lastError: lastErr,
          lastErrorAt: lastErr ? this.now().toISOString() : null
        })
        for (const e of errored) repos.errors.add(`check:${e.label}`, e.error ?? 'エラー')
        return { status: 'success', message, snapshot: firstStored, matches: allMatches, notified: totalNotified, failedNotifications: totalFailed, desktop: allDesktop }
      } catch (e) {
        return this.failRun(runId, provider.id, e)
      }
    }

    // Single-snapshot path (mock provider, manual import, legacy single-account).
    try {
      const snap = imported ?? (await provider.fetchStore(this.providerContext()))
      if (!snap.offers.length) throw new Error('ストア情報が空です')
      const periodKey = computePeriodKey(snap)
      const res = await this.processSnapshot(snap, settings, webhook, snap.accountName ?? null, false)
      const periodDate = new Date(snap.periodStart ?? (snap.periodEnd ? new Date(new Date(snap.periodEnd).getTime() - 86_400_000) : snap.fetchedAt))
      const message =
        `${formatZonedDate(periodDate, tz)} のストアを確認: 一致 ${res.matches.length}件 / 新規通知 ${res.notified}件` +
        (res.failed ? ` / 通知失敗 ${res.failed}件` : '') +
        (res.unresolved ? ` / カタログ未登録 ${res.unresolved}件` : '') +
        (!webhook && settings.notificationsEnabled && res.matches.length ? ' / 通知先が未設定のため通知なし' : '')
      repos.runs.finish(runId, { status: 'success', periodKey, matched: res.matches.length, notified: res.notified, message })
      repos.monitor.set({
        lastSuccessAt: this.now().toISOString(),
        lastPeriodKey: periodKey,
        lastPeriodEnd: snap.periodEnd ?? null,
        consecutiveFailures: 0,
        lastError: res.failed ? `Discord 通知に失敗しました (${res.failed}件) — 次回チェック時に再送します` : null,
        lastErrorAt: res.failed ? this.now().toISOString() : null
      })
      if (res.failed) repos.errors.add('discord', `通知失敗 ${res.failed}件`)
      return { status: 'success', message, snapshot: res.stored, matches: res.matches, notified: res.notified, failedNotifications: res.failed, desktop: res.desktop }
    } catch (e) {
      return this.failRun(runId, provider.id, e)
    }
  }

  private async failRun(runId: number, providerId: string, e: unknown): Promise<CheckResult> {
    const { repos } = this.deps
    const msg = errorMessage(e)
    const state = repos.monitor.get()
    repos.monitor.set({ lastError: msg, lastErrorAt: this.now().toISOString(), consecutiveFailures: state.consecutiveFailures + 1 })
    repos.runs.finish(runId, { status: 'error', message: msg })
    repos.errors.add(`check:${providerId}`, msg)
    await this.notifyError(msg).catch(() => undefined)
    return { status: 'error', message: msg, snapshot: null, matches: [], notified: 0, failedNotifications: 0, desktop: [] }
  }

  /** The configured destination (BOT DM if set up, else the webhook). */
  async notifier(): Promise<Notifier | null> {
    if (this.deps.getNotifier) return this.deps.getNotifier()
    const url = await this.deps.getWebhookUrl()
    return url ? webhookNotifier(this.deps.fetchImpl, url, this.deps.sendOptions) : null
  }

  private async trySend(target: Notifier, payload: DiscordPayload): Promise<{ ok: boolean; attempts: number; error: string | null }> {
    try {
      const r = await target.send(payload)
      return { ok: true, attempts: r.attempts, error: null }
    } catch (e) {
      return { ok: false, attempts: this.deps.sendOptions?.maxAttempts ?? 5, error: errorMessage(e) }
    }
  }

  /** Error notifications are throttled to once per day (per local date). */
  private async notifyError(msg: string): Promise<void> {
    const { repos } = this.deps
    const s = repos.settings.get()
    if (!s.notificationsEnabled || !s.notifyErrors) return
    const url = await this.notifier()
    if (!url) return
    const key = `err:${formatZonedDate(this.now(), s.timezone)}`
    if (repos.notifications.wasSent('system', key, '', 'error')) return
    const r = await this.trySend(url, buildErrorPayload(msg, s.timezone, this.now()))
    repos.notifications.record('system', key, '', 'error', r.ok, r.attempts, r.error)
  }

  async sendTest(target?: Notifier): Promise<{ ok: boolean; message: string }> {
    target ??= (await this.notifier()) ?? undefined
    if (!target) return { ok: false, message: '通知先（Webhook または BOT）が設定されていません' }
    const r = await this.trySend(target, buildTestPayload())
    this.deps.repos.notifications.record('system', `test:${this.now().toISOString()}`, '', 'test', r.ok, r.attempts, r.error)
    this.deps.onChange?.()
    return r.ok
      ? { ok: true, message: target.kind === 'bot' ? 'DMにテスト通知を送信しました。Discordを確認してください。' : 'テスト通知を送信しました。Discordを確認してください。' } : { ok: false, message: r.error ?? '送信に失敗しました' }
  }
}

export function webhookNotifier(fetchImpl: FetchLike, url: string, opts?: SendOptions): Notifier {
  return { kind: 'webhook', send: (p) => sendWebhook(fetchImpl, url, p, opts) }
}
