import type { StoreSnapshot } from '../types'
import { VP_CURRENCY_ID } from '../types'
import { ProviderUnavailableError, type ProviderContext, type ProviderStatus, type StoreProvider } from './StoreProvider'
import { utcDayBounds } from './period'

/** Typical VP prices by content tier dev name (approximation for demo data only). */
const MOCK_PRICES: Record<string, number> = { Select: 875, Deluxe: 1275, Premium: 1775, Exclusive: 2175, Ultra: 2475 }

function hash(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface MockOptions {
  seed: string
  /** Always include the top-priority wishlist skin (demo / verification). */
  forceWishlistHit: boolean
  /** Explicit skin ids to include (tests). */
  forceSkinIds?: string[]
  /** Simulate failures: number of upcoming calls that should throw. */
  failNext?: number
}

/**
 * Generates a deterministic fake daily store (4 skins) per UTC day from the local catalog.
 * Offers use skin LEVEL ids like the real storefront does, so ID normalization is exercised.
 */
export class MockStoreProvider implements StoreProvider {
  readonly id = 'mock'
  readonly displayName = 'テスト用ストア（Mock）'
  readonly supportsAutomatic = true
  readonly usesUnofficialRiotApi = false
  public calls = 0

  constructor(
    public options: MockOptions,
    /** Optional map baseSkinId -> first level id (tests can inject). */
    private levelIdOf?: (skinId: string) => string | null
  ) {}

  async status(ctx: ProviderContext): Promise<ProviderStatus> {
    const n = ctx.catalog().length
    return n >= 4
      ? { ready: true, message: 'テスト用の疑似ストアを使用中（実際のストアではありません）', accountLabel: 'テストアカウント' }
      : { ready: false, message: 'スキンカタログが未取得です。カタログを更新してください。' }
  }

  async fetchStore(ctx: ProviderContext): Promise<StoreSnapshot> {
    this.calls++
    if (this.options.failNext && this.options.failNext > 0) {
      this.options.failNext--
      throw new Error('Mock: 擬似的な取得エラー')
    }
    const skins = ctx.catalog().filter((s) => !s.removed && s.tierId)
    if (skins.length < 4) throw new ProviderUnavailableError('スキンカタログが未取得です')
    const { start, end } = utcDayBounds(ctx.now)
    const rand = rng(hash(`${this.options.seed}|${start.toISOString()}`))
    const chosen: string[] = []
    const forced = [...(this.options.forceSkinIds ?? [])]
    if (this.options.forceWishlistHit) {
      const top = [...ctx.wishlist()].sort((a, b) => rankP(a.priority) - rankP(b.priority) || a.position - b.position)[0]
      if (top) forced.push(top.skinId)
    }
    for (const f of forced) if (chosen.length < 4 && !chosen.includes(f)) chosen.push(f)
    let guard = 0
    while (chosen.length < 4 && guard++ < 1000) {
      const s = skins[Math.floor(rand() * skins.length)]
      if (!chosen.includes(s.id)) chosen.push(s.id)
    }
    const byId = new Map(skins.map((s) => [s.id, s]))
    return {
      accountId: 'mock-account',
      accountName: 'テストアカウント',
      fetchedAt: ctx.now.toISOString(),
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      source: this.id,
      offers: chosen.map((id) => ({
        itemId: this.levelIdOf?.(id) ?? id,
        price: MOCK_PRICES[byId.get(id)?.tierDevName ?? ''] ?? 1775,
        currencyId: VP_CURRENCY_ID
      }))
    }
  }
}

function rankP(p: string): number {
  return p === 'high' ? 0 : p === 'normal' ? 1 : 2
}
