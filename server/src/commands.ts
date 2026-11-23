import {
  RiotStoreProvider,
  RiotAuthRequiredError,
  resolveOffers,
  matchWishlist,
  buildDailyPayload,
  buildNightMarketPayload,
  buildBundlePayload,
  type CatalogRepo,
  type CookieJar,
  type DiscordPayload,
  type FetchLike,
  type StoreSnapshot,
  type AuthorizeFn
} from '../../src/core'
import type { SecretBox } from './crypto'
import { loadAccountCookies, saveAccountCookies, type ServerRiotAccount, type ServerUser, type UserStore } from './userStore'

export interface CommandDeps {
  userStore: UserStore
  box: SecretBox
  catalog: Pick<CatalogRepo, 'resolveSkinId' | 'getSkin' | 'findByName' | 'allSkins' | 'count'>
  fetchImpl: FetchLike
  authorize: AuthorizeFn
  getClientVersion: () => Promise<string>
  timezone?: string
  now?: () => Date
  /** Minimum seconds between on-demand fetches per account (avoid hammering Riot). */
  minFetchIntervalMs?: number
}

export type CommandName = 'store' | 'check' | 'wishlist' | 'nightmarket' | 'bundle'

/** An ephemeral Discord reply (only the invoking user sees it). */
export interface CommandReply {
  payload: DiscordPayload
  ephemeral: boolean
}

const FLAG_EPHEMERAL = 64
const lastFetch = new Map<string, number>()

export class CommandService {
  constructor(private deps: CommandDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }
  private tz(): string {
    return this.deps.timezone ?? 'Asia/Tokyo'
  }

  /** Builds a single-account RiotStoreProvider whose cookies live in the server user store (encrypted). */
  private provider(discordUserId: string, acc: ServerRiotAccount): RiotStoreProvider {
    return new RiotStoreProvider({
      fetchImpl: this.deps.fetchImpl,
      authorize: this.deps.authorize,
      loadCookies: () => loadAccountCookies(this.deps.box, discordUserId, acc),
      saveCookies: (jar: CookieJar) => {
        saveAccountCookies(this.deps.box, discordUserId, acc, jar) // Riot may rotate ssid
        this.persist(discordUserId)
      },
      loadAccount: () => (acc.puuid ? { puuid: acc.puuid, gameName: acc.gameName, region: acc.region } : null),
      saveAccount: (a) => {
        if (a) {
          acc.puuid = a.puuid
          acc.gameName = a.gameName
          acc.region = a.region
        }
        this.persist(discordUserId)
      },
      getRegionSetting: () => acc.regionOverride,
      getClientVersion: this.deps.getClientVersion,
      riskAcknowledged: () => true,
      now: this.deps.now
    })
  }

  private persist(discordUserId: string): void {
    const u = this.deps.userStore.getUser(discordUserId)
    if (u) this.deps.userStore.upsertUser(u)
  }

  private requireUser(discordUserId: string): ServerUser | CommandReply {
    const u = this.deps.userStore.getUser(discordUserId)
    if (!u || !u.consentedAt) return this.text('まだ連携していません。`/connect` で登録してください（同意が必要です）。')
    if (!u.accounts.length) return this.text('Riotアカウントが登録されていません。`/connect` でログインしてください。')
    return u
  }

  private text(msg: string): CommandReply {
    return { payload: { content: msg, allowed_mentions: { parse: [] } }, ephemeral: true }
  }

  async handle(discordUserId: string, name: CommandName, options: Record<string, string> = {}): Promise<CommandReply> {
    const u = this.requireUser(discordUserId)
    if ('payload' in u) return u
    switch (name) {
      case 'store':
      case 'check':
        return this.store(u, options.account)
      case 'wishlist':
        return this.wishlist(u)
      case 'nightmarket':
        return this.nightMarket(u, options.account)
      case 'bundle':
        return this.bundle(u, options.account)
    }
  }

  private accountsFor(u: ServerUser, which?: string): ServerRiotAccount[] {
    if (!which || which === 'all') return u.accounts
    const found = u.accounts.find((a) => a.key === which || a.label === which)
    return found ? [found] : u.accounts
  }

  private async fetchFor(u: ServerUser, acc: ServerRiotAccount): Promise<{ snap?: StoreSnapshot; error?: string; relogin?: boolean }> {
    const guardKey = `${u.discordUserId}:${acc.key}`
    const min = this.deps.minFetchIntervalMs ?? 20_000
    const last = lastFetch.get(guardKey) ?? 0
    if (this.now().getTime() - last < min) return { error: '短時間に連続で実行されました。少し待ってから再度お試しください。' }
    lastFetch.set(guardKey, this.now().getTime())
    try {
      const snap = await this.provider(u.discordUserId, acc).fetchStore({ now: this.now(), catalog: () => this.deps.catalog.allSkins(), wishlist: () => [] })
      acc.needsRelogin = false
      acc.lastPeriodEnd = snap.periodEnd ?? null
      this.deps.userStore.upsertUser(u)
      return { snap }
    } catch (e) {
      if (e instanceof RiotAuthRequiredError) {
        acc.needsRelogin = true
        this.deps.userStore.upsertUser(u)
        return { error: `「${acc.label}」のログインが切れています。\`/connect\` で再ログインしてください。`, relogin: true }
      }
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async store(u: ServerUser, which?: string): Promise<CommandReply> {
    const accounts = this.accountsFor(u, which)
    const wishlist = u.wishlistSkinIds.map((id) => ({ skinId: id, priority: 'normal' as const, position: 0, addedAt: '', skin: this.deps.catalog.getSkin(id) }))
    const embeds: DiscordPayload['embeds'] = []
    const notes: string[] = []
    for (const acc of accounts) {
      const r = await this.fetchFor(u, acc)
      if (r.error || !r.snap) {
        notes.push(`⚠️ ${acc.label}: ${r.error ?? '取得失敗'}`)
        continue
      }
      const offers = resolveOffers(r.snap, this.deps.catalog)
      const matches = matchWishlist(offers, wishlist)
      const periodDate = new Date(r.snap.periodStart ?? r.snap.fetchedAt)
      const daily = buildDailyPayload(offers, this.tz(), periodDate, new Set(matches.map((m) => m.offer.skinId!)), accounts.length > 1 ? acc.label : null)
      embeds.push(...(daily.embeds ?? []))
    }
    if (!embeds.length) return this.text(notes.join('\n') || 'ストアを取得できませんでした。')
    return { payload: { content: notes.join('\n') || undefined, embeds: embeds.slice(0, 10), allowed_mentions: { parse: [] } }, ephemeral: true }
  }

  private async nightMarket(u: ServerUser, which?: string): Promise<CommandReply> {
    const accounts = this.accountsFor(u, which)
    const wishIds = new Set(u.wishlistSkinIds)
    const embeds: DiscordPayload['embeds'] = []
    for (const acc of accounts) {
      const r = await this.fetchFor(u, acc)
      if (!r.snap?.nightMarket?.offers.length) continue
      // resolve via snapshot save path reuse: build ResolvedNightMarket inline
      const nm = {
        endsAt: r.snap.nightMarket.endsAt,
        offers: r.snap.nightMarket.offers.map((o) => {
          const skinId = this.deps.catalog.resolveSkinId(o.itemId)
          return { skinId, skin: skinId ? this.deps.catalog.getSkin(skinId) : null, realPrice: o.realPrice ?? null, nmPrice: o.nmPrice ?? null, percent: o.percent ?? null }
        })
      }
      const payload = buildNightMarketPayload(nm, this.tz(), wishIds, accounts.length > 1 ? acc.label : null)
      embeds.push(...(payload.embeds ?? []))
    }
    if (!embeds.length) return this.text('現在ナイトマーケットは開催されていません。')
    return { payload: { embeds: embeds.slice(0, 10), allowed_mentions: { parse: [] } }, ephemeral: true }
  }

  private async bundle(u: ServerUser, which?: string): Promise<CommandReply> {
    const acc = this.accountsFor(u, which)[0]
    const r = await this.fetchFor(u, acc)
    if (!r.snap?.bundles?.length) return this.text('バンドル情報を取得できませんでした。')
    const embeds: DiscordPayload['embeds'] = []
    for (const b of r.snap.bundles) {
      const resolved = {
        bundleId: b.bundleId,
        name: null,
        icon: null,
        endsAt: b.endsAt,
        totalBase: b.totalBase ?? null,
        totalDiscounted: b.totalDiscounted ?? null,
        items: b.items.map((it) => {
          const skinId = this.deps.catalog.resolveSkinId(it.itemId)
          return { skinId, skin: skinId ? this.deps.catalog.getSkin(skinId) : null, typeId: it.typeId ?? null, basePrice: it.basePrice ?? null, discountedPrice: it.discountedPrice ?? null, discountPercent: it.discountPercent ?? null }
        }).filter((i) => i.skin),
        otherItemCount: 0
      }
      embeds.push(...(buildBundlePayload(resolved, this.tz()).embeds ?? []))
    }
    return { payload: { embeds: embeds.slice(0, 10), allowed_mentions: { parse: [] } }, ephemeral: true }
  }

  private wishlist(u: ServerUser): CommandReply {
    if (!u.wishlistSkinIds.length) return this.text('ウィッシュリストは空です。アプリで登録してください。')
    const lines = u.wishlistSkinIds
      .map((id) => this.deps.catalog.getSkin(id))
      .filter(Boolean)
      .map((s) => `・${s!.nameJa}（${s!.weaponNameJa}）`)
    return { payload: { content: `🎯 ウィッシュリスト（${lines.length}件）\n${lines.join('\n')}`.slice(0, 2000), allowed_mentions: { parse: [] } }, ephemeral: true }
  }
}

export const commandFlags = (r: CommandReply): number => (r.ephemeral ? FLAG_EPHEMERAL : 0)
