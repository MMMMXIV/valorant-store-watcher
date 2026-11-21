import { describe, expect, it } from 'vitest'
import {
  RiotStoreProvider,
  RiotAuthRequiredError,
  RIOT_CLIENT_PLATFORM,
  applySetCookies,
  parseSsidInput,
  parseTokenRedirect,
  redact,
  VP_CURRENCY_ID,
  type AuthorizeFn,
  type CookieJar,
  type RiotAccountInfo
} from '../src/core'
import { createTestApp, findSkin, levelIdsOf } from './helpers'

const PUUID = '11111111-2222-3333-4444-555555555555'
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (exp: number) => `${b64({ alg: 'RS256' })}.${b64({ sub: PUUID, exp })}.sig`

interface FakeRiot {
  provider: RiotStoreProvider
  calls: string[]
  jar: { value: CookieJar | null }
  account: { value: RiotAccountInfo | null }
  clock: { now: number }
  opts: { cookieValid: boolean; authDown?: boolean; silent?: 'ok' | 'login' | null; pasRegion: string; storeQueue: Array<{ status: number; body: unknown }>; offers: string[] }
  lastStoreHeaders: Record<string, string> | null
}

function fakeRiot(ack = true, regionSetting = 'auto'): FakeRiot {
  const f: FakeRiot = {
    calls: [],
    jar: { value: null },
    account: { value: null },
    clock: { now: Date.parse('2026-11-21T03:00:00Z') },
    opts: { cookieValid: true, pasRegion: 'ap', storeQueue: [], offers: ['aaaaaaaa-0000-0000-0000-00000000000a'] },
    lastStoreHeaders: null,
    provider: null as never
  }
  const authorize: AuthorizeFn = async (_url, cookie) => {
    f.calls.push('authorize')
    if (f.opts.authDown) return { status: 403, location: null, setCookies: [] } // e.g. Cloudflare / outage
    if (!f.opts.cookieValid || !cookie.includes('ssid=')) return { status: 303, location: 'https://auth.riotgames.com/login', setCookies: [] }
    const token = jwt(Math.floor(f.clock.now / 1000) + 3600)
    return {
      status: 303,
      location: `https://playvalorant.com/opt_in#access_token=${token}&scope=account+openid&iss=x&id_token=IDTOKEN&token_type=Bearer&session_state=s&expires_in=3600`,
      setCookies: ['ssid=ROTATED_SSID_VALUE_1234567890; Path=/; Secure; HttpOnly', 'tdid=abc; Path=/']
    }
  }
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    f.calls.push(`${init?.method ?? 'GET'} ${u.host}${u.pathname}`)
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (u.host === 'entitlements.auth.riotgames.com') return json(200, { entitlements_token: 'ENT_TOKEN' })
    if (u.pathname === '/userinfo') return json(200, { sub: PUUID, acct: { game_name: 'Tester', tag_line: 'JP1' } })
    if (u.host === 'riot-geo.pas.si.riotgames.com') return json(200, { token: 'x', affinities: { pbe: 'na', live: f.opts.pasRegion } })
    if (u.pathname.startsWith('/store/v3/storefront/')) {
      f.lastStoreHeaders = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
      const q = f.opts.storeQueue.shift()
      if (q) return json(q.status, q.body)
      return json(200, {
        FeaturedBundle: { Bundles: [] },
        SkinsPanelLayout: {
          SingleItemOffers: f.opts.offers,
          SingleItemStoreOffers: f.opts.offers.map((id, i) => ({ OfferID: id, IsDirectPurchase: true, Cost: { [VP_CURRENCY_ID]: 1275 + i * 500 }, Rewards: [{ ItemTypeID: 'e7c63390', ItemID: id, Quantity: 1 }] })),
          SingleItemOffersRemainingDurationInSeconds: 75600
        }
      })
    }
    return json(404, {})
  }
  f.provider = new RiotStoreProvider({
    fetchImpl,
    authorize,
    loadCookies: () => f.jar.value,
    saveCookies: (j) => (f.jar.value = j),
    loadAccount: () => f.account.value,
    saveAccount: (a) => (f.account.value = a),
    getRegionSetting: () => regionSetting,
    getClientVersion: async () => 'release-13.10-shipping-18-5893614',
    riskAcknowledged: () => ack,
    silentRelogin: async () => {
      f.calls.push('silent')
      if (f.opts.silent !== 'ok') return null
      return { redirectUrl: `https://playvalorant.com/opt_in#access_token=${jwt(Math.floor(f.clock.now / 1000) + 3600)}&id_token=ID&expires_in=3600`, cookies: { ssid: 'SILENT_SSID_1234567890', tdid: 'dev' } }
    },
    now: () => new Date(f.clock.now)
  })
  return f
}
const ctx = { now: new Date(), catalog: () => [], wishlist: () => [] }

describe('Riot provider (非公式)', () => {
  it('logs in with ssid, rotates cookies, detects account & region, fetches storefront v3', async () => {
    const f = fakeRiot()
    f.opts.offers = ['AAAAAAAA-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002']
    const a = await f.provider.loginWithSsid('ORIGINAL_SSID_VALUE_ABCDEFG')
    expect(a).toEqual({ puuid: PUUID, gameName: 'Tester#JP1', region: 'ap' })
    expect(f.jar.value).toMatchObject({ ssid: 'ROTATED_SSID_VALUE_1234567890', tdid: 'abc' })
    const snap = await f.provider.fetchStore(ctx)
    expect(f.calls.at(-1)).toBe(`POST pd.ap.a.pvp.net/store/v3/storefront/${PUUID}`)
    expect(f.lastStoreHeaders).toMatchObject({
      'X-Riot-Entitlements-JWT': 'ENT_TOKEN',
      'X-Riot-ClientVersion': 'release-13.10-shipping-18-5893614',
      'X-Riot-ClientPlatform': RIOT_CLIENT_PLATFORM
    })
    expect(f.lastStoreHeaders!.Authorization).toMatch(/^Bearer /)
    expect(snap).toMatchObject({ accountId: PUUID, accountName: 'Tester#JP1', source: 'riot', periodEnd: '2026-11-22T00:00:00.000Z' })
    expect(snap.offers).toEqual([
      { itemId: 'AAAAAAAA-0000-0000-0000-000000000001', price: 1275, currencyId: VP_CURRENCY_ID },
      { itemId: 'aaaaaaaa-0000-0000-0000-000000000002', price: 1775, currencyId: VP_CURRENCY_ID }
    ])
    expect(Buffer.from(RIOT_CLIENT_PLATFORM, 'base64').toString()).toContain('"platformOS": "Windows"')
  })

  it('reuses the token within its lifetime and re-auths silently after expiry', async () => {
    const f = fakeRiot()
    await f.provider.loginWithSsid('ORIGINAL_SSID_VALUE_ABCDEFG')
    await f.provider.fetchStore(ctx)
    const n = f.calls.filter((c) => c === 'authorize').length
    f.clock.now += 20 * 60_000
    await f.provider.fetchStore(ctx)
    expect(f.calls.filter((c) => c === 'authorize').length).toBe(n)
    f.clock.now += 50 * 60_000 // past exp - 5min
    await f.provider.fetchStore(ctx)
    expect(f.calls.filter((c) => c === 'authorize').length).toBe(n + 1)
    expect(f.calls.filter((c) => c.includes('pas.si')).length).toBe(1) // region is cached
  })

  it('re-authenticates once on BAD_CLAIMS', async () => {
    const f = fakeRiot()
    await f.provider.loginWithSsid('ORIGINAL_SSID_VALUE_ABCDEFG')
    f.clock.now += 60_000
    f.opts.storeQueue.push({ status: 400, body: { httpStatus: 400, errorCode: 'BAD_CLAIMS' } })
    await expect(f.provider.fetchStore(ctx)).resolves.toMatchObject({ accountId: PUUID })
  })

  it('expired cookie → needs re-login, and stops calling Riot until login', async () => {
    const f = fakeRiot()
    await f.provider.loginWithSsid('ORIGINAL_SSID_VALUE_ABCDEFG')
    f.opts.cookieValid = false
    f.clock.now += 2 * 3600_000
    await expect(f.provider.fetchStore(ctx)).rejects.toBeInstanceOf(RiotAuthRequiredError)
    expect(f.provider.needsRelogin).toBe(true)
    expect((await f.provider.status()).ready).toBe(false)
    const before = f.calls.length
    await expect(f.provider.fetchStore(ctx)).rejects.toBeInstanceOf(RiotAuthRequiredError)
    expect(f.calls.length).toBe(before)
    f.opts.cookieValid = true
    f.clock.now += 60_000
    await f.provider.loginWithSsid('NEW_SSID_VALUE_ABCDEFGHIJ')
    expect(f.provider.needsRelogin).toBe(false)
  })

  it('maintenance, latam shard mapping, manual region, risk gate', async () => {
    const f = fakeRiot()
    f.opts.pasRegion = 'latam'
    await f.provider.loginWithSsid('ORIGINAL_SSID_VALUE_ABCDEFG')
    await f.provider.fetchStore(ctx)
    expect(f.calls.at(-1)).toContain('pd.na.a.pvp.net')
    f.opts.storeQueue.push({ status: 403, body: { httpStatus: 403, errorCode: 'SCHEDULED_DOWNTIME' } })
    await expect(f.provider.fetchStore(ctx)).rejects.toThrow(/メンテナンス/)

    const g = fakeRiot(true, 'kr')
    await g.provider.loginWithSsid('ORIGINAL_SSID_VALUE_ABCDEFG')
    await g.provider.fetchStore(ctx)
    expect(g.calls.at(-1)).toContain('pd.kr.a.pvp.net')

    const h = fakeRiot(false)
    await expect(h.provider.fetchStore(ctx)).rejects.toThrow(/リスク確認/)
    expect((await h.provider.status()).ready).toBe(false)
  })

  it('completeLogin from the login-window redirect', async () => {
    const f = fakeRiot()
    const url = `https://playvalorant.com/opt_in#access_token=${jwt(Math.floor(f.clock.now / 1000) + 3600)}&id_token=ID&expires_in=3600`
    const a = await f.provider.completeLogin(url, { ssid: 'SSID_FROM_WINDOW_1234567890', clid: 'x' })
    expect(a.gameName).toBe('Tester#JP1')
    expect(f.calls).not.toContain('authorize')
    await expect(f.provider.completeLogin('https://playvalorant.com/opt_in', { ssid: 'x' })).rejects.toThrow()
  })

  it('end-to-end with the watcher core: real store → wishlist match → Discord, deduped', async () => {
    const { core, discord, clock } = await createTestApp({ now: '2026-11-21T03:00:00Z' })
    const f = fakeRiot()
    f.clock.now = clock.now.getTime()
    const skin = findSkin(core, 'RGX 11z Pro Vandal')
    core.repos.wishlist.add(skin.id, 'high')
    f.opts.offers = [levelIdsOf(core, skin.id)[0].toUpperCase(), findSkin(core, 'Araxys Vandal').id]
    core.registerProvider(f.provider)
    core.repos.settings.update({ providerId: 'riot' })
    await f.provider.loginWithSsid('ORIGINAL_SSID_VALUE_ABCDEFG')
    const r1 = await core.checkService.runCheck('manual')
    expect(r1).toMatchObject({ status: 'success', notified: 1 })
    expect(discord.calls[0].body.embeds[0].title).toContain(skin.nameJa)
    const r2 = await core.checkService.runCheck('auto')
    expect(r2.notified).toBe(0)
    expect(discord.calls).toHaveLength(1)
    expect(core.repos.stores.latest()!.accountName).toBe('Tester#JP1')
    // scheduler uses the store's real refresh time
    expect(core.scheduler.plan()).toMatchObject({ reason: 'source-refresh' })
  })
})

describe('再ログインの手間を減らす仕組み', () => {
  it('a temporary auth-server error does NOT require re-login', async () => {
    const f = fakeRiot()
    await f.provider.loginWithSsid('ORIGINAL_SSID_VALUE_ABCDEFG')
    f.opts.authDown = true
    f.clock.now += 2 * 3600_000
    await expect(f.provider.fetchStore(ctx)).rejects.toThrow(/一時的/)
    expect(f.provider.needsRelogin).toBe(false)
    expect(f.calls).not.toContain('silent')
    f.opts.authDown = false
    f.clock.now += 60_000
    await expect(f.provider.fetchStore(ctx)).resolves.toMatchObject({ accountId: PUUID })
  })

  it('expired cookie → silent re-login with the remembered Riot session, no user action', async () => {
    const f = fakeRiot()
    await f.provider.loginWithSsid('ORIGINAL_SSID_VALUE_ABCDEFG')
    f.opts.cookieValid = false
    f.opts.silent = 'ok'
    f.clock.now += 2 * 3600_000
    await expect(f.provider.fetchStore(ctx)).resolves.toMatchObject({ accountId: PUUID })
    expect(f.calls).toContain('silent')
    expect(f.provider.needsRelogin).toBe(false)
    expect(f.jar.value).toMatchObject({ ssid: 'SILENT_SSID_1234567890' })
  })

  it('silent re-login impossible → needs re-login, and the scheduler stops', async () => {
    const { core } = await createTestApp()
    const f = fakeRiot()
    core.registerProvider(f.provider)
    core.repos.settings.update({ providerId: 'riot' })
    await f.provider.loginWithSsid('ORIGINAL_SSID_VALUE_ABCDEFG')
    expect(core.scheduler.plan()).not.toBeNull()
    f.opts.cookieValid = false
    f.opts.silent = 'login'
    f.clock.now += 2 * 3600_000
    await expect(f.provider.fetchStore(ctx)).rejects.toBeInstanceOf(RiotAuthRequiredError)
    expect(f.provider.needsRelogin).toBe(true)
    expect(core.scheduler.plan()).toBeNull() // no pointless retries / no mock fallback
  })

  it('keepAlive refreshes the session only when it is older than 12h', async () => {
    const f = fakeRiot()
    await f.provider.loginWithSsid('ORIGINAL_SSID_VALUE_ABCDEFG')
    const auths = () => f.calls.filter((c) => c === 'authorize').length
    const n = auths()
    f.clock.now += 3 * 3600_000
    expect(await f.provider.keepAlive()).toBe(false)
    f.clock.now += 10 * 3600_000
    expect(await f.provider.keepAlive()).toBe(true)
    expect(auths()).toBe(n + 1)
    expect(f.jar.value!.ssid).toBe('ROTATED_SSID_VALUE_1234567890')
  })
})

describe('Riot helpers', () => {
  it('parses ssid input variants', () => {
    expect(parseSsidInput('eyJhbGciOiJ.abc_DEF-123456789012')).toBe('eyJhbGciOiJ.abc_DEF-123456789012')
    expect(parseSsidInput('ssid=abcdefghijklmnopqrstuvwxyz; Path=/')).toBe('abcdefghijklmnopqrstuvwxyz')
    expect(parseSsidInput('clid=x; ssid=abcdefghijklmnopqrstuvwxyz; tdid=y')).toBe('abcdefghijklmnopqrstuvwxyz')
    expect(parseSsidInput('short')).toBeNull()
    expect(parseSsidInput('foo=bar')).toBeNull()
  })
  it('applies Set-Cookie including deletions', () => {
    const j = applySetCookies({ ssid: 'a', old: 'x' }, ['ssid=b; Path=/', 'old=; Max-Age=0', 'new=1; Expires=Wed, 01 Jan 2099 00:00:00 GMT'])
    expect(j).toEqual({ ssid: 'b', new: '1' })
  })
  it('parses token redirects and never logs tokens', () => {
    const url = 'https://playvalorant.com/opt_in#access_token=AAA.BBB.CCC&id_token=III&expires_in=3600'
    expect(parseTokenRedirect(url)).toEqual({ accessToken: 'AAA.BBB.CCC', idToken: 'III', expiresIn: 3600 })
    expect(redact(`redirect ${url} cookie ssid=SECRETSSID`)).not.toMatch(/AAA\.BBB|III|SECRETSSID/)
  })
})
