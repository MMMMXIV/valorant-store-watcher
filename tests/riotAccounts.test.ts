import { describe, expect, it } from 'vitest'
import {
  RiotAccountsProvider,
  DuplicateRiotAccountError,
  accountDisplay,
  VP_CURRENCY_ID,
  type AuthorizeFn,
  type CookieJar,
  type RiotAccountRecord
} from '../src/core'
import { createTestApp, findSkin, levelIdsOf } from './helpers'

const MAIN = 'aaaaaaaa-0000-0000-0000-00000000main'.replace('main', '0001')
const SUB = 'bbbbbbbb-0000-0000-0000-000000000002'
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')

/** Fake Riot that knows two accounts, told apart by their ssid cookie. */
function fakeRiotMulti() {
  const users: Record<string, { puuid: string; name: string; tag: string }> = {
    SSID_MAIN_ABCDEFGHIJKLMNOP: { puuid: MAIN, name: 'MainPlayer', tag: 'JP1' },
    SSID_SUB_ABCDEFGHIJKLMNOPQ: { puuid: SUB, name: 'SubPlayer', tag: 'JP2' }
  }
  const state = {
    now: Date.parse('2026-11-21T03:00:00Z'),
    expired: new Set<string>(),
    failStoreFor: new Set<string>(),
    offers: {} as Record<string, string[]>,
    calls: [] as string[]
  }
  const jwt = (puuid: string) => `${b64({ alg: 'RS256' })}.${b64({ sub: puuid, exp: Math.floor(state.now / 1000) + 3600 })}.sig`
  const authorize: AuthorizeFn = async (_u, cookie) => {
    const ssid = /ssid=([^;]+)/.exec(cookie)?.[1] ?? ''
    state.calls.push(`authorize:${ssid.slice(5, 9)}`)
    const u = users[ssid]
    if (!u || state.expired.has(ssid)) return { status: 303, location: 'https://auth.riotgames.com/login', setCookies: [] }
    return { status: 303, location: `https://playvalorant.com/opt_in#access_token=${jwt(u.puuid)}&id_token=ID&expires_in=3600`, setCookies: [] }
  }
  const sub = (auth: string | undefined) => JSON.parse(Buffer.from((auth ?? '').replace('Bearer ', '').split('.')[1] ?? '', 'base64url').toString() || '{}').sub as string
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (u.host.startsWith('entitlements')) return json(200, { entitlements_token: 'E' })
    if (u.pathname === '/userinfo') {
      const p = sub(headers.Authorization)
      const user = Object.values(users).find((x) => x.puuid === p)!
      return json(200, { sub: p, acct: { game_name: user.name, tag_line: user.tag } })
    }
    if (u.host.startsWith('riot-geo')) return json(200, { affinities: { live: 'ap' } })
    if (u.pathname.startsWith('/store/v3/storefront/')) {
      const p = decodeURIComponent(u.pathname.split('/').pop()!)
      state.calls.push(`store:${p === MAIN ? 'main' : 'sub'}`)
      if (state.failStoreFor.has(p)) return json(503, {})
      const ids = state.offers[p] ?? []
      return json(200, {
        SkinsPanelLayout: {
          SingleItemOffers: ids,
          SingleItemStoreOffers: ids.map((id) => ({ OfferID: id, Cost: { [VP_CURRENCY_ID]: 1775 }, Rewards: [{ ItemID: id }] })),
          SingleItemOffersRemainingDurationInSeconds: 75600
        }
      })
    }
    return json(404, {})
  }
  let accounts: RiotAccountRecord[] = []
  const jars = new Map<string, CookieJar>()
  const provider = new RiotAccountsProvider({
    fetchImpl,
    authorize,
    loadAccounts: () => accounts,
    saveAccounts: (l) => (accounts = l),
    loadCookies: (k) => jars.get(k) ?? null,
    saveCookies: (k, j) => jars.set(k, j),
    deleteCookies: (k) => jars.delete(k),
    getClientVersion: async () => 'release-13.10',
    riskAcknowledged: () => true,
    now: () => new Date(state.now)
  })
  return { provider, state, jars, accounts: () => accounts }
}

const ctx = { now: new Date(), catalog: () => [], wishlist: () => [] }

describe('複数Riotアカウント', () => {
  it('registers main + sub, each with its own login, and refuses the same account twice', async () => {
    const f = fakeRiotMulti()
    const m = await f.provider.addFromSsid('main', 'メイン', 'SSID_MAIN_ABCDEFGHIJKLMNOP')
    const s = await f.provider.addFromSsid('k2', 'サブ', 'SSID_SUB_ABCDEFGHIJKLMNOPQ')
    expect([m.gameName, s.gameName]).toEqual(['MainPlayer#JP1', 'SubPlayer#JP2'])
    expect(f.accounts().map((a) => a.label)).toEqual(['メイン', 'サブ'])
    expect(accountDisplay(s)).toBe('SubPlayer#JP2（サブ）')
    // same Riot account again → rejected and nothing left behind
    f.state.now += 20_000
    await expect(f.provider.addFromSsid('k3', 'もう一つ', 'SSID_MAIN_ABCDEFGHIJKLMNOP')).rejects.toBeInstanceOf(DuplicateRiotAccountError)
    expect(f.accounts()).toHaveLength(2)
    expect(f.jars.has('k3')).toBe(false)
  })

  it('fetches every account one after another; one failure does not stop the other', async () => {
    const f = fakeRiotMulti()
    await f.provider.addFromSsid('main', 'メイン', 'SSID_MAIN_ABCDEFGHIJKLMNOP')
    await f.provider.addFromSsid('k2', 'サブ', 'SSID_SUB_ABCDEFGHIJKLMNOPQ')
    f.state.offers[MAIN] = ['11111111-1111-1111-1111-111111111111']
    f.state.offers[SUB] = ['22222222-2222-2222-2222-222222222222']
    f.state.failStoreFor.add(MAIN)
    const items = await f.provider.fetchStores(ctx, { force: false })
    expect(items.map((i) => [i.label, !!i.snapshot, !!i.error])).toEqual([
      ['MainPlayer#JP1（メイン）', false, true],
      ['SubPlayer#JP2（サブ）', true, false]
    ])
    expect(items[1].snapshot!.accountId).toBe(SUB)
    // retry: the sub's store is fresh for this period → skipped, only main is fetched again
    f.state.failStoreFor.clear()
    const before = f.state.calls.filter((c) => c.startsWith('store:')).length
    const items2 = await f.provider.fetchStores(ctx, { force: false })
    expect(items2.map((i) => i.skipped ?? (i.snapshot ? 'ok' : 'err'))).toEqual(['ok', 'fresh'])
    expect(f.state.calls.filter((c) => c.startsWith('store:')).length - before).toBe(1)
    // a manual check refetches both
    const items3 = await f.provider.fetchStores(ctx, { force: true })
    expect(items3.every((i) => i.snapshot)).toBe(true)
  })

  it('an expired sub account needs re-login on its own; main keeps working', async () => {
    const f = fakeRiotMulti()
    await f.provider.addFromSsid('main', 'メイン', 'SSID_MAIN_ABCDEFGHIJKLMNOP')
    await f.provider.addFromSsid('k2', 'サブ', 'SSID_SUB_ABCDEFGHIJKLMNOPQ')
    f.state.offers[MAIN] = ['11111111-1111-1111-1111-111111111111']
    f.state.offers[SUB] = ['22222222-2222-2222-2222-222222222222']
    f.state.expired.add('SSID_SUB_ABCDEFGHIJKLMNOPQ')
    f.state.now += 2 * 3600_000 // tokens expired → both re-auth with cookies
    const items = await f.provider.fetchStores(ctx, { force: true })
    expect(items[0].snapshot).toBeTruthy()
    expect(items[1]).toMatchObject({ relogin: true })
    expect(f.provider.needsRelogin('k2')).toBe(true)
    expect(f.provider.needsRelogin('main')).toBe(false)
    expect(f.provider.canRunAutomatically()).toBe(true)
    expect(f.provider.anyNeedsRelogin).toBe(true)
    // next run: the sub is skipped without contacting Riot
    const n = f.state.calls.length
    const items2 = await f.provider.fetchStores(ctx, { force: true })
    expect(items2[1].skipped).toBe('relogin')
    expect(f.state.calls.slice(n).some((c) => c.includes('SUB_'))).toBe(false)
  })

  it('re-login with a different Riot account is refused', async () => {
    const f = fakeRiotMulti()
    await f.provider.addFromSsid('main', 'メイン', 'SSID_MAIN_ABCDEFGHIJKLMNOP')
    f.state.now += 20_000
    await expect(f.provider.reloginFromSsid('main', 'SSID_SUB_ABCDEFGHIJKLMNOPQ')).rejects.toThrow(/別のアカウント/)
    expect(f.accounts()[0]).toMatchObject({ puuid: MAIN, gameName: 'MainPlayer#JP1' })
  })

  it('pipeline: wishlist hit on the SUB account is notified with the account name, deduped per account', async () => {
    const { core, discord } = await createTestApp()
    const f = fakeRiotMulti()
    f.state.now = core.repos.settings.get() && Date.parse('2026-11-21T00:10:00Z')
    core.registerProvider(f.provider)
    core.repos.settings.update({ providerId: 'riot', riskAcknowledged: true })
    await f.provider.addFromSsid('main', 'メイン', 'SSID_MAIN_ABCDEFGHIJKLMNOP')
    await f.provider.addFromSsid('k2', 'サブ', 'SSID_SUB_ABCDEFGHIJKLMNOPQ')
    const reaver = findSkin(core, 'RGX 11z Pro Vandal')
    const other = findSkin(core, 'Araxys Vandal')
    core.repos.wishlist.add(reaver.id, 'high')
    f.state.offers[MAIN] = [other.id]
    f.state.offers[SUB] = [levelIdsOf(core, reaver.id)[0]]

    const r1 = await core.checkService.runCheck('manual')
    expect(r1.status).toBe('success')
    expect(r1.message).toContain('取得 2アカウント')
    expect(r1.notified).toBe(1)
    expect(discord.calls).toHaveLength(1)
    expect(discord.calls[0].body.content).toContain('【SubPlayer#JP2（サブ）】')
    expect(r1.desktop[0].body).toContain('SubPlayer#JP2（サブ）')
    // both stores are kept per account
    expect(core.repos.stores.list().map((s) => s.accountName).sort()).toEqual(['MainPlayer#JP1', 'SubPlayer#JP2'])

    // same day again → no duplicate
    const r2 = await core.checkService.runCheck('manual')
    expect(r2.notified).toBe(0)
    expect(discord.calls).toHaveLength(1)

    // the same skin on MAIN the same day → separately notified (different account)
    f.state.offers[MAIN] = [reaver.id]
    const r3 = await core.checkService.runCheck('manual')
    expect(r3.notified).toBe(1)
    expect(discord.calls[1].body.content).toContain('【MainPlayer#JP1（メイン）】')
  })

  it('a single account keeps the old notification wording (no account label)', async () => {
    const { core, discord } = await createTestApp()
    const f = fakeRiotMulti()
    f.state.now = Date.parse('2026-11-21T00:10:00Z')
    core.registerProvider(f.provider)
    core.repos.settings.update({ providerId: 'riot', riskAcknowledged: true })
    await f.provider.addFromSsid('main', 'メイン', 'SSID_MAIN_ABCDEFGHIJKLMNOP')
    const reaver = findSkin(core, 'RGX 11z Pro Vandal')
    core.repos.wishlist.add(reaver.id)
    f.state.offers[MAIN] = [reaver.id]
    await core.checkService.runCheck('manual')
    expect(discord.calls[0].body.content).not.toContain('【')
  })
})
