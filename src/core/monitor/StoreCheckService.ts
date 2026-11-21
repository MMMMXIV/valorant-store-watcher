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
import type { ProviderContext, StoreProvider } from '../providers/StoreProvider'
import { computePeriodKey } from '../providers/period'
import type { CheckTrigger, MatchResult, StoredSnapshot, StoreSnapshot } from '../types'
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
}

export interface CheckServiceDeps {
  repos: Repos
  getProvider: () => StoreProvider
  getWebhookUrl: () => Promise<string | null>
  fetchImpl: FetchLike
  now?: () => Date
  sendOptions?: SendOptions
  onChange?: () => void
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
      this.running = this.doRun(trigger, imported).finally(() => {
        this.running = null
        this.deps.onChange?.()
      })
    }
    return this.running
  }

  private async doRun(trigger: CheckTrigger, imported?: StoreSnapshot): Promise<CheckResult> {
    const { repos } = this.deps
    const provider = this.deps.getProvider()
    const settings = repos.settings.get()
    const runId = repos.runs.start(trigger, imported ? imported.source : provider.id)
    const startedAt = this.now()
    repos.monitor.set({ lastAttemptAt: startedAt.toISOString() })
    try {
      const snap = imported ?? (await provider.fetchStore(this.providerContext()))
      if (!snap.offers.length) throw new Error('ストア情報が空です')
      const offers = resolveOffers(snap, repos.catalog)
      const periodKey = computePeriodKey(snap)
      const snapshotId = repos.stores.save(
        {
          accountId: snap.accountId,
          accountName: snap.accountName ?? null,
          periodKey,
          periodStart: snap.periodStart ?? null,
          periodEnd: snap.periodEnd ?? null,
          fetchedAt: snap.fetchedAt,
          source: snap.source
        },
        offers
      )
      const stored = repos.stores.list(200).find((s) => s.id === snapshotId) ?? null
      const matches = matchWishlist(offers, repos.wishlist.list())
      const periodDate = new Date(snap.periodStart ?? (snap.periodEnd ? new Date(new Date(snap.periodEnd).getTime() - 86_400_000) : snap.fetchedAt))

      let notified = 0
      let failed = 0
      const webhook = settings.notificationsEnabled ? await this.deps.getWebhookUrl() : null
      const unresolved = offers.filter((o) => !o.skinId).length

      if (webhook && settings.notifyWishlist) {
        const pending = matches.filter((m) => !repos.notifications.wasSent(snap.accountId, periodKey, m.offer.skinId!, 'wishlist'))
        for (const { payload, skinIds } of buildWishlistPayloads(pending, settings.timezone, periodDate)) {
          const r = await this.trySend(webhook, payload)
          for (const id of skinIds) repos.notifications.record(snap.accountId, periodKey, id, 'wishlist', r.ok, r.attempts, r.error)
          if (r.ok) notified += skinIds.length
          else failed += skinIds.length
        }
      }
      if (webhook && settings.notifyDailyStore && !repos.notifications.wasSent(snap.accountId, periodKey, '', 'daily')) {
        const r = await this.trySend(webhook, buildDailyPayload(offers, settings.timezone, periodDate, new Set(matches.map((m) => m.offer.skinId!))))
        repos.notifications.record(snap.accountId, periodKey, '', 'daily', r.ok, r.attempts, r.error)
        if (!r.ok) failed++
      }

      const message =
        `${formatZonedDate(periodDate, settings.timezone)} のストアを確認: 一致 ${matches.length}件 / 新規通知 ${notified}件` +
        (failed ? ` / 通知失敗 ${failed}件` : '') +
        (unresolved ? ` / カタログ未登録 ${unresolved}件` : '') +
        (!webhook && settings.notificationsEnabled && matches.length ? ' / Webhook未設定のため通知なし' : '')
      repos.runs.finish(runId, { status: 'success', periodKey, matched: matches.length, notified, message })
      repos.monitor.set({
        lastSuccessAt: this.now().toISOString(),
        lastPeriodKey: periodKey,
        lastPeriodEnd: snap.periodEnd ?? null,
        consecutiveFailures: 0,
        lastError: failed ? `Discord 通知に失敗しました (${failed}件) — 次回チェック時に再送します` : null,
        lastErrorAt: failed ? this.now().toISOString() : null
      })
      if (failed) repos.errors.add('discord', `通知失敗 ${failed}件`)
      return { status: 'success', message, snapshot: stored, matches, notified, failedNotifications: failed }
    } catch (e) {
      const msg = errorMessage(e)
      const state = repos.monitor.get()
      repos.monitor.set({ lastError: msg, lastErrorAt: this.now().toISOString(), consecutiveFailures: state.consecutiveFailures + 1 })
      repos.runs.finish(runId, { status: 'error', message: msg })
      repos.errors.add(`check:${provider.id}`, msg)
      await this.notifyError(msg).catch(() => undefined)
      return { status: 'error', message: msg, snapshot: null, matches: [], notified: 0, failedNotifications: 0 }
    }
  }

  private async trySend(url: string, payload: DiscordPayload): Promise<{ ok: boolean; attempts: number; error: string | null }> {
    try {
      const r = await sendWebhook(this.deps.fetchImpl, url, payload, this.deps.sendOptions)
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
    const url = await this.deps.getWebhookUrl()
    if (!url) return
    const key = `err:${formatZonedDate(this.now(), s.timezone)}`
    if (repos.notifications.wasSent('system', key, '', 'error')) return
    const r = await this.trySend(url, buildErrorPayload(msg, s.timezone, this.now()))
    repos.notifications.record('system', key, '', 'error', r.ok, r.attempts, r.error)
  }

  async sendTest(url?: string): Promise<{ ok: boolean; message: string }> {
    const target = url ?? (await this.deps.getWebhookUrl())
    if (!target) return { ok: false, message: 'Webhook URLが設定されていません' }
    const r = await this.trySend(target, buildTestPayload())
    this.deps.repos.notifications.record('system', `test:${this.now().toISOString()}`, '', 'test', r.ok, r.attempts, r.error)
    this.deps.onChange?.()
    return r.ok ? { ok: true, message: 'テスト通知を送信しました。Discordを確認してください。' } : { ok: false, message: r.error ?? '送信に失敗しました' }
  }
}
