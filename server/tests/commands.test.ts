import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AppDatabase, buildCatalog, createRepos, VP_CURRENCY_ID, type AuthorizeFn } from '../../src/core'
import { SecretBox } from '../src/crypto'
import { CommandService } from '../src/commands'
import { InMemoryUserStore, saveAccountCookies, type ServerRiotAccount, type ServerUser } from '../src/userStore'

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tests/fixtures/catalog.json'), 'utf8'))

const MAIN = 'aaaaaaaa-0000-0000-0000-000000000a01'
const SUB = 'bbbbbbbb-0000-0000-0000-000000000b02'
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const SKIN_TYPE = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433'

async function makeCatalog() {
  const db = await AppDatabase.open(null)
  const repos = createRepos(db)
  repos.catalog.replaceAll(buildCatalog(fixture.weaponsJa, fixture.weaponsEn, fixture.tiersJa, fixture.tiersEn))
  return repos.catalog
}

function fakeRiot() {
  const users: Record<string, { puuid: string; name: string; tag: string }> = {
    SSID_MAIN_abcdefghijklmnop: { puuid: MAIN, name: 'MainP', tag: 'JP1' },
    SSID_SUB_abcdefghijklmnopq: { puuid: SUB, name: 'SubP', tag: 'JP2' }
  }
  const state = { now: Date.parse('2026-11-23T03:00:00Z'), expired: new Set<string>(), offers: {} as Record<string, string[]>, nm: {} as Record<string, string[]> }
  const jwt = (p: string) => `${b64({ a: 1 })}.${b64({ sub: p, exp: Math.floor(state.now / 1000) + 3600 })}.s`
  const authorize: AuthorizeFn = async (_u, cookie) => {
    const ssid = /ssid=([^;]+)/.exec(cookie)?.[1] ?? ''
    const u = users[ssid]
    if (!u || state.expired.has(ssid)) return { status: 303, location: 'https://auth.riotgames.com/login', setCookies: [] }
    return { status: 303, location: `https://playvalorant.com/opt_in#access_token=${jwt(u.puuid)}&id_token=I&expires_in=3600`, setCookies: [] }
  }
  const sub = (a?: string) => JSON.parse(Buffer.from((a ?? '').replace('Bearer ', '').split('.')[1] ?? '', 'base64url').toString() || '{}').sub as string
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    const h = (init?.headers ?? {}) as Record<string, string>
    const json = (s: number, o: unknown) => new Response(JSON.stringify(o), { status: s })
    if (u.host.startsWith('entitlements')) return json(200, { entitlements_token: 'E' })
    if (u.pathname === '/userinfo') {
      const p = sub(h.Authorization)
      const user = Object.values(users).find((x) => x.puuid === p)!
      return json(200, { sub: p, acct: { game_name: user.name, tag_line: user.tag } })
    }
    if (u.host.startsWith('riot-geo')) return json(200, { affinities: { live: 'ap' } })
    if (u.pathname.startsWith('/store/v3/storefront/')) {
      const p = decodeURIComponent(u.pathname.split('/').pop()!)
      const ids = state.offers[p] ?? []
      const nm = state.nm[p]
      return json(200, {
        SkinsPanelLayout: { SingleItemStoreOffers: ids.map((id) => ({ OfferID: id, Cost: { [VP_CURRENCY_ID]: 1775 }, Rewards: [{ ItemID: id }] })), SingleItemOffersRemainingDurationInSeconds: 60000 },
        ...(nm ? { BonusStore: { BonusStoreOffers: nm.map((id) => ({ Offer: { OfferID: id, Cost: { [VP_CURRENCY_ID]: 1775 }, Rewards: [{ ItemID: id }] }, DiscountCosts: { [VP_CURRENCY_ID]: 1065 }, DiscountPercent: 40 })), BonusStoreRemainingDurationInSeconds: 5 * 86400 } } : {})
      })
    }
    return json(404, {})
  }
  return { authorize, fetchImpl, state, users }
}

function account(key: string, label: string, puuid: string): ServerRiotAccount {
  return { key, label, puuid, gameName: null, region: null, regionOverride: 'auto', lastPeriodEnd: null, encCookies: null, needsRelogin: false }
}

describe('サーバー: Discordコマンド', () => {
  it('encrypts cookies and cannot decrypt them for another user', () => {
    const box = new SecretBox(SecretBox.generateKey())
    const packed = box.encrypt(JSON.stringify({ ssid: 'secret' }), 'user1:acc1')
    expect(packed).not.toContain('secret')
    expect(JSON.parse(box.decrypt(packed, 'user1:acc1')).ssid).toBe('secret')
    expect(() => box.decrypt(packed, 'user2:acc1')).toThrow() // AAD mismatch
  })

  it('/store fetches the user own store and flags wishlist hits', async () => {
    const catalog = await makeCatalog()
    const reaver = catalog.allSkins().find((s) => s.nameEn === 'RGX 11z Pro Vandal')!
    const box = new SecretBox(SecretBox.generateKey())
    const store = new InMemoryUserStore()
    const riot = fakeRiot()
    riot.state.offers[MAIN] = [reaver.id, catalog.allSkins().find((s) => s.nameEn === 'Araxys Vandal')!.id]
    const acc = account('main', 'メイン', MAIN)
    saveAccountCookies(box, 'discord-1', acc, { ssid: 'SSID_MAIN_abcdefghijklmnop' })
    const user: ServerUser = { discordUserId: 'discord-1', consentedAt: '2026-11-01', consentVersion: '1', pushToken: null, accounts: [acc], wishlistSkinIds: [reaver.id] }
    store.upsertUser(user)
    const svc = new CommandService({ userStore: store, box, catalog, fetchImpl: riot.fetchImpl, authorize: riot.authorize, getClientVersion: async () => 'v', now: () => new Date(riot.state.now) })

    const r = await svc.handle('discord-1', 'store')
    expect(r.ephemeral).toBe(true)
    expect(r.payload.embeds!.length).toBe(2)
    const titles = r.payload.embeds!.map((e) => e.title)
    expect(titles.some((t) => t!.includes(reaver.nameJa) && t!.includes('ウィッシュリスト'))).toBe(true)
    // rotated cookie persisted (still decryptable), account identity filled in
    expect(store.getUser('discord-1')!.accounts[0].gameName).toBe('MainP#JP1')
  })

  it('refuses unknown user and empty wishlist gracefully', async () => {
    const catalog = await makeCatalog()
    const box = new SecretBox(SecretBox.generateKey())
    const store = new InMemoryUserStore()
    const riot = fakeRiot()
    const svc = new CommandService({ userStore: store, box, catalog, fetchImpl: riot.fetchImpl, authorize: riot.authorize, getClientVersion: async () => 'v', now: () => new Date(riot.state.now) })
    expect((await svc.handle('nobody', 'store')).payload.content).toContain('連携していません')

    const acc = account('main', 'メイン', MAIN)
    saveAccountCookies(box, 'u2', acc, { ssid: 'SSID_MAIN_abcdefghijklmnop' })
    store.upsertUser({ discordUserId: 'u2', consentedAt: 'x', consentVersion: '1', pushToken: null, accounts: [acc], wishlistSkinIds: [] })
    expect((await svc.handle('u2', 'wishlist')).payload.content).toContain('空です')
  })

  it('expired login tells the user to reconnect; needsRelogin is set', async () => {
    const catalog = await makeCatalog()
    const box = new SecretBox(SecretBox.generateKey())
    const store = new InMemoryUserStore()
    const riot = fakeRiot()
    riot.state.expired.add('SSID_SUB_abcdefghijklmnopq')
    const acc = account('k2', 'サブ', SUB)
    saveAccountCookies(box, 'u3', acc, { ssid: 'SSID_SUB_abcdefghijklmnopq' })
    store.upsertUser({ discordUserId: 'u3', consentedAt: 'x', consentVersion: '1', pushToken: null, accounts: [acc], wishlistSkinIds: [] })
    const svc = new CommandService({ userStore: store, box, catalog, fetchImpl: riot.fetchImpl, authorize: riot.authorize, getClientVersion: async () => 'v', now: () => new Date(riot.state.now), minFetchIntervalMs: 0 })
    const r = await svc.handle('u3', 'store')
    expect(r.payload.content).toContain('再ログイン')
    expect(store.getUser('u3')!.accounts[0].needsRelogin).toBe(true)
  })

  it('/nightmarket shows discounts when active', async () => {
    const catalog = await makeCatalog()
    const reaver = catalog.allSkins().find((s) => s.nameEn === 'RGX 11z Pro Vandal')!
    const box = new SecretBox(SecretBox.generateKey())
    const store = new InMemoryUserStore()
    const riot = fakeRiot()
    riot.state.offers[MAIN] = [catalog.allSkins()[0].id]
    riot.state.nm[MAIN] = [reaver.id]
    const acc = account('main', 'メイン', MAIN)
    saveAccountCookies(box, 'u4', acc, { ssid: 'SSID_MAIN_abcdefghijklmnop' })
    store.upsertUser({ discordUserId: 'u4', consentedAt: 'x', consentVersion: '1', pushToken: null, accounts: [acc], wishlistSkinIds: [reaver.id] })
    const svc = new CommandService({ userStore: store, box, catalog, fetchImpl: riot.fetchImpl, authorize: riot.authorize, getClientVersion: async () => 'v', now: () => new Date(riot.state.now), minFetchIntervalMs: 0 })
    const r = await svc.handle('u4', 'nightmarket')
    expect(r.payload.embeds![0].description).toContain(`⭐ ${reaver.nameJa}`)
  })
})
