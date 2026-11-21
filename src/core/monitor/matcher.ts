import type { CatalogRepo } from '../db/repositories'
import type { MatchResult, ResolvedOffer, StoreSnapshot, WishlistItem } from '../types'
import { normalizeUuid } from '../util/ids'

/**
 * Resolves raw store offers (level / chroma / skin ids) to BASE skin ids.
 * Name lookup is only a fallback for manually typed entries without ids.
 */
export function resolveOffers(snapshot: StoreSnapshot, catalog: Pick<CatalogRepo, 'resolveSkinId' | 'getSkin' | 'findByName'>): ResolvedOffer[] {
  return snapshot.offers.map((o, slot) => {
    const raw = normalizeUuid(o.itemId)
    let skinId = raw ? catalog.resolveSkinId(raw) : null
    if (!skinId && !raw && o.name) {
      const hits = catalog.findByName(o.name.trim())
      if (hits.length === 1) skinId = hits[0].id
    }
    return {
      slot,
      rawItemId: raw,
      skinId,
      price: typeof o.price === 'number' ? o.price : null,
      currencyId: o.currencyId ?? null,
      skin: skinId ? catalog.getSkin(skinId) : null
    }
  })
}

const P_RANK = { high: 0, normal: 1, low: 2 } as const

/** Returns every wishlist hit (multiple hits supported), ordered by priority then wishlist position. */
export function matchWishlist(offers: ResolvedOffer[], wishlist: WishlistItem[]): MatchResult[] {
  const byId = new Map(wishlist.map((w) => [w.skinId, w]))
  const seen = new Set<string>()
  const out: MatchResult[] = []
  for (const offer of offers) {
    if (!offer.skinId || seen.has(offer.skinId)) continue
    const wish = byId.get(offer.skinId)
    if (wish) {
      seen.add(offer.skinId)
      out.push({ offer, wish })
    }
  }
  return out.sort((a, b) => P_RANK[a.wish.priority] - P_RANK[b.wish.priority] || a.wish.position - b.wish.position)
}
