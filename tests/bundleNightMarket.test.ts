import { describe, expect, it } from 'vitest'
import { parseStoreImport, VP_CURRENCY_ID } from '../src/core'
import { createTestApp, findSkin, levelIdsOf } from './helpers'

const SKIN_TYPE = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433'

function storefront(opts: { daily: string[]; bundle?: { id: string; items: string[]; secs: number }; nm?: { offers: Array<{ id: string; off: number }>; secs: number } }) {
  return {
    SkinsPanelLayout: {
      SingleItemStoreOffers: opts.daily.map((id) => ({ OfferID: id, Cost: { [VP_CURRENCY_ID]: 1775 }, Rewards: [{ ItemID: id }] })),
      SingleItemOffersRemainingDurationInSeconds: 60000
    },
    ...(opts.bundle
      ? {
          FeaturedBundle: {
            Bundles: [
              {
                DataAssetID: opts.bundle.id,
                DurationRemainingInSeconds: opts.bundle.secs,
                TotalBaseCost: { [VP_CURRENCY_ID]: 7100 },
                TotalDiscountedCost: { [VP_CURRENCY_ID]: 5000 },
                Items: opts.bundle.items.map((id) => ({ Item: { ItemID: id, ItemTypeID: SKIN_TYPE, Amount: 1 }, BasePrice: 1775, DiscountedPrice: 1250, DiscountPercent: 30 }))
              }
            ]
          }
        }
      : {}),
    ...(opts.nm
      ? {
          BonusStore: {
            BonusStoreOffers: opts.nm.offers.map((o) => ({ Offer: { OfferID: o.id, Cost: { [VP_CURRENCY_ID]: 1775 }, Rewards: [{ ItemID: o.id }] }, DiscountCosts: { [VP_CURRENCY_ID]: Math.round(1775 * (1 - o.off / 100)) }, DiscountPercent: o.off })),
            BonusStoreRemainingDurationInSeconds: opts.nm.secs
          }
        }
      : {})
  }
}

describe('バンドルとナイトマーケット', () => {
  it('parses a storefront with a bundle and night market', () => {
    const now = new Date('2026-11-22T03:00:00Z')
    const snap = parseStoreImport(
      JSON.stringify(storefront({ daily: ['aaaaaaaa-0000-0000-0000-000000000001'], bundle: { id: 'bbbbbbbb-0000-0000-0000-0000000000b1', items: ['cccccccc-0000-0000-0000-0000000000c1'], secs: 7 * 86400 }, nm: { offers: [{ id: 'dddddddd-0000-0000-0000-0000000000d1', off: 40 }], secs: 5 * 86400 } })),
      now
    )
    expect(snap.bundles).toHaveLength(1)
    expect(snap.bundles![0]).toMatchObject({ bundleId: 'bbbbbbbb-0000-0000-0000-0000000000b1', totalDiscounted: 5000, totalBase: 7100 })
    expect(snap.bundles![0].items[0]).toMatchObject({ itemId: 'cccccccc-0000-0000-0000-0000000000c1', discountPercent: 30 })
    expect(snap.nightMarket!.offers[0]).toMatchObject({ itemId: 'dddddddd-0000-0000-0000-0000000000d1', percent: 40, nmPrice: 1065 })
  })

  it('notifies a bundle rotation once, then again when the bundle changes', async () => {
    const { core, discord, clock } = await createTestApp()
    const bundleSkin = findSkin(core, 'RGX 11z Pro Vandal')
    const daily = findSkin(core, 'Araxys Vandal')
    const now = () => clock.now
    const snap1 = parseStoreImport(JSON.stringify(storefront({ daily: [daily.id], bundle: { id: 'bbbbbbbb-0000-0000-0000-0000000000b1', items: [levelIdsOf(core, bundleSkin.id)[0]], secs: 7 * 86400 } })), now())
    const r1 = await core.checkService.runCheck('import', snap1)
    expect(r1.status).toBe('success')
    const bundleMsg = discord.calls.find((c) => c.body.content?.includes('新しいバンドル'))
    expect(bundleMsg).toBeTruthy()
    expect(bundleMsg!.body.embeds[0].description).toContain(bundleSkin.nameJa)
    expect(core.repos.stores.latest()!.bundles[0].items[0].skin!.id).toBe(bundleSkin.id)

    // same bundle again → no repeat
    const before = discord.calls.length
    await core.checkService.runCheck('import', snap1)
    expect(discord.calls.filter((c) => c.body.content?.includes('新しいバンドル')).length).toBe(1)
    expect(discord.calls.length).toBe(before)

    // a different bundle → notified again
    clock.now = new Date(clock.now.getTime() + 8 * 86400_000)
    const snap2 = parseStoreImport(JSON.stringify(storefront({ daily: [daily.id], bundle: { id: 'eeeeeeee-0000-0000-0000-0000000000e2', items: [bundleSkin.id], secs: 7 * 86400 } })), clock.now)
    await core.checkService.runCheck('import', snap2)
    expect(discord.calls.filter((c) => c.body.content?.includes('新しいバンドル')).length).toBe(2)

    // off switch
    core.repos.settings.update({ notifyBundle: false })
    clock.now = new Date(clock.now.getTime() + 8 * 86400_000)
    const snap3 = parseStoreImport(JSON.stringify(storefront({ daily: [daily.id], bundle: { id: 'ffffffff-0000-0000-0000-0000000000f3', items: [bundleSkin.id], secs: 7 * 86400 } })), clock.now)
    await core.checkService.runCheck('import', snap3)
    expect(discord.calls.filter((c) => c.body.content?.includes('新しいバンドル')).length).toBe(2)
  })

  it('notifies the night market once, flags wishlist skins, and respects the off switch', async () => {
    const { core, discord, clock } = await createTestApp()
    const wish = findSkin(core, 'RGX 11z Pro Phantom')
    const other = findSkin(core, 'Xenohunter Phantom')
    core.repos.wishlist.add(wish.id)
    const snap = parseStoreImport(
      JSON.stringify(storefront({ daily: [findSkin(core, 'Araxys Vandal').id], nm: { offers: [{ id: levelIdsOf(core, wish.id)[0], off: 35 }, { id: other.id, off: 20 }], secs: 5 * 86400 } })),
      clock.now
    )
    const r = await core.checkService.runCheck('import', snap)
    expect(r.status).toBe('success')
    const nmMsg = discord.calls.find((c) => c.body.content?.includes('ナイトマーケット'))
    expect(nmMsg).toBeTruthy()
    expect(nmMsg!.body.embeds[0].description).toContain(`⭐ ${wish.nameJa}`)
    expect(core.repos.stores.latest()!.nightMarket!.offers).toHaveLength(2)
    // re-check same event → no duplicate
    await core.checkService.runCheck('import', snap)
    expect(discord.calls.filter((c) => c.body.content?.includes('ナイトマーケット')).length).toBe(1)
    // desktop notice present
    const nmDesk = r.desktop.find((d) => d.title.includes('ナイトマーケット'))
    expect(nmDesk?.body).toContain('ウィッシュリスト 1個')
  })

  it('no bundle/night market in the payload means no such notification', async () => {
    const { core, discord, clock } = await createTestApp()
    const snap = parseStoreImport(JSON.stringify(storefront({ daily: [findSkin(core, 'Araxys Vandal').id] })), clock.now)
    await core.checkService.runCheck('import', snap)
    expect(discord.calls.some((c) => c.body.content?.includes('バンドル') || c.body.content?.includes('ナイトマーケット'))).toBe(false)
    expect(core.repos.stores.latest()!.bundles).toHaveLength(0)
    expect(core.repos.stores.latest()!.nightMarket).toBeNull()
  })
})
