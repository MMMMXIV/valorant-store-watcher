import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  computePeriodKey,
  normalizeUuid,
  parseStoreImport,
  planNextCheck,
  redact,
  searchSkins,
  sendWebhook,
  DEFAULT_SETTINGS,
  SettingsPatchSchema,
  EMPTY_MONITOR_STATE,
  DiscordPermanentError,
  isValidWebhookUrl,
  nextOccurrence,
  previousOccurrence,
  VP_CURRENCY_ID,
  type StoreSnapshot
} from '../src/core'
import { WEBHOOK, catalogData, createTestApp, fakeDiscord, findSkin, levelIdsOf, tmpDir } from './helpers'

function store(skinIds: string[], day: string, extra: Partial<StoreSnapshot> = {}): StoreSnapshot {
  const start = new Date(`${day}T00:00:00Z`)
  return {
    accountId: 'acc-1',
    fetchedAt: new Date(start.getTime() + 10 * 60_000).toISOString(),
    periodStart: start.toISOString(),
    periodEnd: new Date(start.getTime() + 86_400_000).toISOString(),
    source: 'test',
    offers: skinIds.map((id) => ({ itemId: id, price: 1775, currencyId: VP_CURRENCY_ID })),
    ...extra
  }
}

describe('1. ウィッシュリストの追加・削除', () => {
  it('adds, lists, reorders, sets priority and removes', async () => {
    const { core } = await createTestApp()
    const a = findSkin(core, 'Araxys Vandal').id
    const b = findSkin(core, 'RGX 11z Pro Phantom').id
    core.repos.wishlist.add(a)
    core.repos.wishlist.add(b, 'high')
    core.repos.wishlist.add(a) // duplicate is a no-op
    expect(core.repos.wishlist.list().map((w) => w.skinId)).toEqual([a, b])
    core.repos.wishlist.reorder([b, a])
    expect(core.repos.wishlist.list().map((w) => w.skinId)).toEqual([b, a])
    core.repos.wishlist.setPriority(a, 'low')
    expect(core.repos.wishlist.list().find((w) => w.skinId === a)!.priority).toBe('low')
    expect(core.repos.wishlist.remove(b)).toBe(true)
    expect(core.repos.wishlist.list().map((w) => [w.skinId, w.position])).toEqual([[a, 0]])
    expect(() => core.repos.wishlist.add('00000000-0000-0000-0000-000000000000')).toThrow()
  })

  it('stores the BASE skin id even when a level/chroma id is added', async () => {
    const { core } = await createTestApp()
    const s = findSkin(core, 'RGX 11z Pro Vandal')
    const chroma = levelIdsOf(core, s.id, 'chroma')[1]
    core.repos.wishlist.add(chroma.toUpperCase())
    expect(core.repos.wishlist.list()[0].skinId).toBe(s.id)
  })
})

describe('2. SQLiteへの保存 / 11. 再起動時の状態復元', () => {
  it('persists data to the file and restores after restart', async () => {
    const dir = tmpDir()
    const dbPath = path.join(dir, 'vsw.sqlite')
    const app1 = await createTestApp({ dbPath })
    const skin = findSkin(app1.core, 'RGX 11z Pro Vandal')
    app1.core.repos.wishlist.add(skin.id, 'high')
    app1.core.repos.settings.update({ checkTime: '10:30', notifyDailyStore: true })
    const r1 = await app1.core.checkService.runCheck('manual', store([levelIdsOf(app1.core, skin.id)[0]], '2026-11-21'))
    expect(r1.notified).toBe(1)
    app1.core.close()
    expect(fs.existsSync(dbPath)).toBe(true)

    const app2 = await createTestApp({ dbPath })
    expect(app2.core.repos.catalog.count()).toBeGreaterThan(30)
    expect(app2.core.repos.wishlist.list()[0]).toMatchObject({ skinId: skin.id, priority: 'high' })
    expect(app2.core.repos.settings.get()).toMatchObject({ checkTime: '10:30', notifyDailyStore: true })
    expect(app2.core.repos.monitor.get().lastSuccessAt).not.toBeNull()
    expect(app2.core.repos.stores.list()).toHaveLength(1)
    // same period after restart → no duplicate wishlist notification
    const r2 = await app2.core.checkService.runCheck('manual', store([levelIdsOf(app2.core, skin.id)[0]], '2026-11-21'))
    expect(r2.notified).toBe(0)
    expect(app2.discord.calls).toHaveLength(0)
    app2.core.close()
  })
})

describe('3. スキンID正規化', () => {
  it('normalizes uuids', () => {
    expect(normalizeUuid(' {9C82E19D-4575-0200-1A81-3EACF00CF872} ')).toBe('9c82e19d-4575-0200-1a81-3eacf00cf872')
    expect(normalizeUuid('not-a-uuid')).toBeNull()
    expect(normalizeUuid(42)).toBeNull()
  })
  it('resolves skin, level and chroma ids to the base skin id', async () => {
    const { core } = await createTestApp()
    const s = findSkin(core, 'RGX 11z Pro Vandal')
    expect(core.repos.catalog.resolveSkinId(s.id)).toBe(s.id)
    for (const l of levelIdsOf(core, s.id, 'level')) expect(core.repos.catalog.resolveSkinId(l.toUpperCase())).toBe(s.id)
    for (const c of levelIdsOf(core, s.id, 'chroma')) expect(core.repos.catalog.resolveSkinId(c)).toBe(s.id)
    expect(levelIdsOf(core, s.id, 'level').length).toBeGreaterThanOrEqual(4)
  })
})

describe('4-8. 照合と通知', () => {
  it('4. notifies a wishlist match with image embed', async () => {
    const { core, discord } = await createTestApp()
    const s = findSkin(core, 'RGX 11z Pro Vandal')
    core.repos.wishlist.add(s.id, 'high')
    const other = findSkin(core, 'Araxys Vandal')
    const r = await core.checkService.runCheck('manual', store([levelIdsOf(core, s.id)[0], other.id], '2026-11-21'))
    expect(r.status).toBe('success')
    expect(r.matches).toHaveLength(1)
    expect(discord.calls).toHaveLength(1)
    const body = discord.calls[0].body
    expect(discord.calls[0].url).toBe(`${WEBHOOK}?wait=true`)
    expect(body.content).toContain('ウィッシュリストのスキンがストアに登場しました')
    expect(body.embeds[0].title).toContain(s.nameJa)
    expect(body.embeds[0].image.url).toMatch(/^https:\/\/media\.valorant-api\.com\//)
    const fields = Object.fromEntries(body.embeds[0].fields.map((f: any) => [f.name, f.value]))
    expect(fields['💰 価格']).toBe('1,775 VP')
    expect(fields['⭐ 優先度']).toBe('高')
    expect(fields['🔫 武器']).toBe('ヴァンダル')
    expect(fields['🕒 ストア更新日']).toBe('2026/11/21')
    expect(core.repos.notifications.list()[0]).toMatchObject({ status: 'sent', kind: 'wishlist', skinId: s.id })
  })

  it('5. does not notify when nothing matches', async () => {
    const { core, discord } = await createTestApp()
    core.repos.wishlist.add(findSkin(core, 'RGX 11z Pro Vandal').id)
    const r = await core.checkService.runCheck('manual', store([findSkin(core, 'Araxys Vandal').id], '2026-11-21'))
    expect(r.status).toBe('success')
    expect(r.matches).toHaveLength(0)
    expect(discord.calls).toHaveLength(0)
    expect(core.repos.notifications.list()).toHaveLength(0)
  })

  it('6. notifies all of multiple matches (priority order)', async () => {
    const { core, discord } = await createTestApp()
    const a = findSkin(core, 'RGX 11z Pro Vandal')
    const b = findSkin(core, 'RGX 11z Pro Phantom')
    const c = findSkin(core, 'RGX 11z Pro Operator')
    core.repos.wishlist.add(a.id)
    core.repos.wishlist.add(b.id)
    core.repos.wishlist.add(c.id, 'high')
    const r = await core.checkService.runCheck('manual', store([a.id, levelIdsOf(core, b.id)[0], levelIdsOf(core, c.id, 'chroma')[0]], '2026-11-21'))
    expect(r.matches.map((m) => m.offer.skinId)).toEqual([c.id, a.id, b.id])
    expect(r.notified).toBe(3)
    expect(discord.calls).toHaveLength(1)
    expect(discord.calls[0].body.embeds).toHaveLength(3)
  })

  it('7. never notifies twice within the same store period', async () => {
    const { core, discord, clock } = await createTestApp()
    const s = findSkin(core, 'RGX 11z Pro Vandal')
    core.repos.wishlist.add(s.id)
    const lvl = levelIdsOf(core, s.id)[0]
    await core.checkService.runCheck('manual', store([lvl], '2026-11-21'))
    // re-check later on the same day; periodEnd drifts by a few seconds like the real API
    clock.now = new Date('2026-11-21T12:00:00Z')
    const snap = store([lvl], '2026-11-21', { periodEnd: '2026-11-22T00:00:03.000Z' })
    const results = await Promise.all([core.checkService.runCheck('manual', snap), core.checkService.runCheck('manual', snap)])
    await core.checkService.runCheck('auto', snap)
    expect(results[0].notified + results[1].notified).toBe(0)
    expect(discord.calls).toHaveLength(1)
    expect(core.repos.stores.list()).toHaveLength(1)
  })

  it('8. re-notifies when the skin re-appears in a later period', async () => {
    const { core, discord, clock } = await createTestApp()
    const s = findSkin(core, 'RGX 11z Pro Vandal')
    core.repos.wishlist.add(s.id)
    await core.checkService.runCheck('manual', store([s.id], '2026-11-21'))
    clock.now = new Date('2026-11-22T00:10:00Z')
    const r = await core.checkService.runCheck('manual', store([s.id], '2026-11-22'))
    expect(r.notified).toBe(1)
    expect(discord.calls).toHaveLength(2)
    expect(core.repos.stores.list()).toHaveLength(2)
    expect(core.repos.stores.appearanceStats()[0]).toMatchObject({ skinId: s.id, count: 2 })
  })

  it('respects notification settings (all off / daily store)', async () => {
    const { core, discord } = await createTestApp()
    const s = findSkin(core, 'RGX 11z Pro Vandal')
    core.repos.wishlist.add(s.id)
    core.repos.settings.update({ notificationsEnabled: false })
    await core.checkService.runCheck('manual', store([s.id], '2026-11-21'))
    expect(discord.calls).toHaveLength(0)
    core.repos.settings.update({ notificationsEnabled: true, notifyWishlist: false, notifyDailyStore: true })
    await core.checkService.runCheck('manual', store([s.id, findSkin(core, 'Araxys Vandal').id], '2026-11-21'))
    await core.checkService.runCheck('manual', store([s.id, findSkin(core, 'Araxys Vandal').id], '2026-11-21'))
    expect(discord.calls).toHaveLength(1)
    expect(discord.calls[0].body.content).toContain('2026/11/21 のストア')
    expect(discord.calls[0].body.embeds).toHaveLength(2)
  })

  it('a failed notification is re-sent on the next check, then deduped', async () => {
    const { core, discord } = await createTestApp()
    const s = findSkin(core, 'RGX 11z Pro Vandal')
    core.repos.wishlist.add(s.id)
    discord.queue.push(500, 500, 500, 500)
    const r1 = await core.checkService.runCheck('manual', store([s.id], '2026-11-21'))
    expect(r1.failedNotifications).toBe(1)
    expect(core.repos.notifications.list()[0].status).toBe('failed')
    const r2 = await core.checkService.runCheck('manual', store([s.id], '2026-11-21'))
    expect(r2.notified).toBe(1)
    const r3 = await core.checkService.runCheck('manual', store([s.id], '2026-11-21'))
    expect(r3.notified).toBe(0)
    expect(discord.calls).toHaveLength(5)
  })
})

describe('9. Discord Webhook 再試行', () => {
  const payload = { content: 'x' }
  it('retries 429 using retry_after and 5xx/network with backoff', async () => {
    const d = fakeDiscord()
    const waits: number[] = []
    d.queue.push({ status: 429, body: JSON.stringify({ retry_after: 2.5 }) }, 502, 'network')
    const r = await sendWebhook(d.fetch, WEBHOOK, payload, { sleepFn: async (ms) => void waits.push(ms) })
    expect(r.attempts).toBe(4)
    expect(waits).toEqual([2750, 2000, 4000])
  })
  it('uses the Retry-After header when the body has none', async () => {
    const d = fakeDiscord()
    const waits: number[] = []
    d.queue.push({ status: 429, body: 'nope', headers: { 'retry-after': '3' } })
    await sendWebhook(d.fetch, WEBHOOK, payload, { sleepFn: async (ms) => void waits.push(ms) })
    expect(waits).toEqual([3250])
  })
  it('does not retry permanent errors (404)', async () => {
    const d = fakeDiscord()
    d.queue.push(404)
    await expect(sendWebhook(d.fetch, WEBHOOK, payload, { sleepFn: async () => undefined })).rejects.toBeInstanceOf(DiscordPermanentError)
    expect(d.calls).toHaveLength(1)
  })
  it('gives up after maxAttempts', async () => {
    const d = fakeDiscord()
    d.queue.push(500, 500, 500)
    await expect(sendWebhook(d.fetch, WEBHOOK, payload, { maxAttempts: 3, sleepFn: async () => undefined })).rejects.toThrow(/500/)
    expect(d.calls).toHaveLength(3)
  })
  it('times out hanging requests', async () => {
    const hang = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))
    await expect(sendWebhook(hang, WEBHOOK, payload, { maxAttempts: 1, timeoutMs: 30 })).rejects.toThrow(/タイムアウト/)
  })
  it('validates webhook urls', () => {
    expect(isValidWebhookUrl(WEBHOOK)).toBe(true)
    expect(isValidWebhookUrl('https://evil.example.com/api/webhooks/1/abc')).toBe(false)
    expect(isValidWebhookUrl('http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz')).toBe(false)
  })
})

describe('10. ストア取得エラーからの復旧（Mock + スケジューラ）', () => {
  it('records the error, schedules a retry, then recovers and notifies', async () => {
    const { core, discord, clock } = await createTestApp({ now: '2026-11-21T00:06:00Z' })
    const s = findSkin(core, 'RGX 11z Pro Vandal')
    core.repos.wishlist.add(s.id, 'high')
    core.repos.settings.update({ providerId: 'mock', mockForceWishlistHit: true, notifyErrors: true })
    core.mock.options.failNext = 1

    expect(await core.scheduler.tick('startup')).toBe(true) // catch-up: 09:05 JST already passed
    let st = core.repos.monitor.get()
    expect(st.consecutiveFailures).toBe(1)
    expect(st.lastError).toContain('擬似的な取得エラー')
    expect(discord.calls[0].body.content).toContain('エラー') // error notification
    expect(core.scheduler.plan()).toMatchObject({ reason: 'retry' })

    clock.now = new Date('2026-11-21T00:08:00Z')
    expect(await core.scheduler.tick()).toBe(false) // retry not due yet (5 min)
    clock.now = new Date('2026-11-21T00:11:30Z')
    expect(await core.scheduler.tick()).toBe(true)
    st = core.repos.monitor.get()
    expect(st.consecutiveFailures).toBe(0)
    expect(st.lastError).toBeNull()
    expect(discord.calls.at(-1)!.body.embeds[0].title).toContain(s.nameJa)

    // later ticks the same day do not fetch again (request suppression)
    const calls = core.mock.calls
    clock.now = new Date('2026-11-21T15:00:00Z')
    expect(await core.scheduler.tick()).toBe(false)
    expect(core.mock.calls).toBe(calls)
    // next day after the source-reported refresh (+5 min): check again and re-notify
    clock.now = new Date('2026-11-22T00:05:30Z')
    expect(core.scheduler.plan()).toMatchObject({ reason: 'source-refresh' })
    expect(await core.scheduler.tick()).toBe(true)
    expect(discord.calls.filter((c) => c.body.embeds?.[0]?.title?.includes(s.nameJa))).toHaveLength(2)
    expect(core.repos.runs.list().map((r) => r.status)).toEqual(['success', 'success', 'error'])
  })

  it('defaults to the Riot source and never falls back to the mock store', async () => {
    const { core } = await createTestApp()
    expect(core.repos.settings.get().providerId).toBe('riot')
    expect(core.provider.id).toBe('riot')
    // Riot is not set up (headless placeholder) → scheduler stays idle instead of using Mock
    expect(core.scheduler.plan()).toBeNull()
    expect(await core.scheduler.tick()).toBe(false)
    expect(core.mock.calls).toBe(0)
    const r = await core.checkService.runCheck('manual')
    expect(r.status).toBe('error')
    expect(core.mock.calls).toBe(0)
    expect(core.repos.runs.lastFor('riot')).toMatchObject({ status: 'error' })
    expect(core.repos.stores.latest('riot')).toBeNull()
  })

  it('migrates legacy v1.0 manual sources to riot (not mock)', async () => {
    const { core } = await createTestApp()
    core.repos.db.run("INSERT OR REPLACE INTO settings(key, value) VALUES ('providerId', '\"manual-file\"')")
    expect(core.repos.settings.get().providerId).toBe('riot')
  })
})

describe('12. カタログ更新後の整合性', () => {
  it('keeps wishlist/history valid when skins are removed and adds new aliases', async () => {
    const { core } = await createTestApp()
    const data = catalogData()
    const victim = data.skins.find((s) => s.nameEn === 'RGX 11z Pro Vandal')!
    core.repos.wishlist.add(victim.id)
    await core.checkService.runCheck('manual', store([victim.id], '2026-11-21'))

    const next = catalogData()
    next.skins = next.skins.filter((s) => s.id !== victim.id)
    const extra = next.skins[0]
    extra.aliases.push({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', kind: 'chroma' })
    extra.nameJa = extra.nameJa + '（更新）'
    const r = core.repos.catalog.replaceAll(next)
    expect(r.removed).toBe(1)
    expect(r.added).toBe(0)
    expect(core.repos.catalog.getSkin(victim.id)!.removed).toBe(true)
    expect(core.repos.catalog.allSkins().some((s) => s.id === victim.id)).toBe(false)
    expect(core.repos.wishlist.list()[0].skin!.nameEn).toBe('RGX 11z Pro Vandal')
    expect(core.repos.stores.latest()!.offers[0].skin).not.toBeNull()
    expect(core.repos.catalog.resolveSkinId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(extra.id)
    expect(core.repos.catalog.getSkin(extra.id)!.nameJa).toContain('（更新）')
    // re-adding restores it
    core.repos.catalog.replaceAll(catalogData())
    expect(core.repos.catalog.getSkin(victim.id)!.removed).toBe(false)
  })

  it('buildCatalog filters default skins and random placeholders; search works in ja/en', () => {
    const data = catalogData()
    expect(data.skins.some((s) => /random/i.test(s.nameEn))).toBe(false)
    expect(data.weapons[0].nameEn).toBe('Vandal')
    const skins = data.skins.map((s) => ({
      ...s,
      weaponNameJa: data.weapons.find((w) => w.id === s.weaponId)!.nameJa,
      weaponNameEn: data.weapons.find((w) => w.id === s.weaponId)!.nameEn,
      tierName: null,
      tierDevName: null,
      tierRank: null,
      tierColor: null,
      removed: false
    }))
    expect(searchSkins(skins, 'rgx ヴァンダル').map((s) => s.nameEn)).toEqual(['RGX 11z Pro Vandal'])
    expect(searchSkins(skins, 'ＲＧＸ　phantom').map((s) => s.nameEn)).toEqual(['RGX 11z Pro Phantom'])
    const op = data.weapons.find((w) => w.nameEn === 'Operator')!.id
    expect(searchSkins(skins, '', op).every((s) => s.weaponId === op)).toBe(true)
  })
})

describe('スケジュール計算', () => {
  const s = { ...DEFAULT_SETTINGS }
  it('computes JST occurrences', () => {
    const now = new Date('2026-11-21T00:00:00Z') // 09:00 JST
    expect(nextOccurrence(now, '09:05', 'Asia/Tokyo').toISOString()).toBe('2026-11-21T00:05:00.000Z')
    expect(previousOccurrence(now, '09:05', 'Asia/Tokyo').toISOString()).toBe('2026-11-20T00:05:00.000Z')
    expect(nextOccurrence(new Date('2026-07-01T12:00:00Z'), '02:30', 'America/New_York').toISOString()).toBe('2026-07-02T06:30:00.000Z')
  })
  it('catch-up when the slot was missed, scheduled otherwise', () => {
    const now = new Date('2026-11-21T03:00:00Z')
    expect(planNextCheck(now, s, EMPTY_MONITOR_STATE)).toMatchObject({ reason: 'catch-up' })
    const p = planNextCheck(now, s, { ...EMPTY_MONITOR_STATE, lastSuccessAt: '2026-11-21T00:06:00Z', lastAttemptAt: '2026-11-21T00:06:00Z' })
    expect(p).toMatchObject({ reason: 'scheduled' })
    expect(p.dueAt.toISOString()).toBe('2026-11-22T00:05:00.000Z')
  })
  it('prefers the source refresh time', () => {
    const p = planNextCheck(new Date('2026-11-21T03:00:00Z'), { ...s, checkTime: '12:00' }, {
      ...EMPTY_MONITOR_STATE,
      lastSuccessAt: '2026-11-21T00:06:00Z',
      lastAttemptAt: '2026-11-21T00:06:00Z',
      lastPeriodEnd: '2026-11-22T00:00:00Z'
    })
    expect(p).toMatchObject({ reason: 'source-refresh' })
    expect(p.dueAt.toISOString()).toBe('2026-11-22T00:05:00.000Z')
  })
  it('backs off on failures and waits for the next slot after retries are exhausted', () => {
    const base = { ...EMPTY_MONITOR_STATE, lastAttemptAt: '2026-11-21T00:05:00Z' }
    expect(planNextCheck(new Date('2026-11-21T00:06:00Z'), s, { ...base, consecutiveFailures: 2 }).dueAt.toISOString()).toBe('2026-11-21T00:20:00.000Z')
    const p = planNextCheck(new Date('2026-11-21T02:00:00Z'), s, { ...base, consecutiveFailures: 5 })
    expect(p.reason).toBe('after-retries')
    expect(p.dueAt.toISOString()).toBe('2026-11-22T00:05:00.000Z')
  })
})

describe('設定の部分更新（画面からの変更）', () => {
  it('a one-field patch never resets other settings to defaults', async () => {
    const { core } = await createTestApp()
    core.repos.settings.update({ riskAcknowledged: true, checkTime: '10:30', notifyDailyStore: true, providerId: 'mock' })
    const patch = SettingsPatchSchema.parse({ notifyChannel: 'bot' })
    expect(patch).toEqual({ notifyChannel: 'bot' })
    core.repos.settings.update(patch)
    expect(core.repos.settings.get()).toMatchObject({ riskAcknowledged: true, checkTime: '10:30', notifyDailyStore: true, providerId: 'mock', notifyChannel: 'bot' })
    expect(SettingsPatchSchema.parse({ providerId: 'manual-file' })).toEqual({ providerId: 'riot' })
    expect(() => SettingsPatchSchema.parse({ checkTime: '25:00' })).toThrow()
    expect(() => SettingsPatchSchema.parse({ unknownKey: 1 })).toThrow()
  })
})

describe('手動取り込み・その他', () => {
  it('parses storefront-shaped JSON and vsw format', () => {
    const now = new Date('2026-11-21T03:00:00Z')
    const sf = parseStoreImport(
      JSON.stringify({
        SkinsPanelLayout: {
          SingleItemOffers: ['a'],
          SingleItemStoreOffers: [{ OfferID: 'x', Cost: { [VP_CURRENCY_ID]: 1275 }, Rewards: [{ ItemID: 'B5F1E6A6-0000-0000-0000-000000000000' }] }],
          SingleItemOffersRemainingDurationInSeconds: 75600
        }
      }),
      now
    )
    expect(sf.offers[0]).toMatchObject({ itemId: 'B5F1E6A6-0000-0000-0000-000000000000', price: 1275 })
    expect(sf.periodEnd).toBe('2026-11-22T00:00:00.000Z')
    const v = parseStoreImport(JSON.stringify({ format: 'vsw-store-v1', date: '2026-11-20', offers: [{ name: 'Araxys Vandal', price: 1775 }] }), now)
    expect(v.periodEnd).toBe('2026-11-21T00:00:00.000Z')
    expect(() => parseStoreImport('{bad', now)).toThrow(/JSON/)
    expect(() => parseStoreImport('{"foo":1}', now)).toThrow(/対応していない/)
  })
  it('resolves name-only manual entries via the catalog', async () => {
    const { core } = await createTestApp()
    const s = findSkin(core, 'Araxys Vandal')
    core.repos.wishlist.add(s.id)
    const snap = parseStoreImport(JSON.stringify({ format: 'vsw-store-v1', offers: [{ name: s.nameJa }] }), new Date('2026-11-21T03:00:00Z'))
    const r = await core.checkService.runCheck('import', snap)
    expect(r.matches).toHaveLength(1)
  })
  it('period keys tolerate drift', () => {
    expect(computePeriodKey({ periodEnd: '2026-11-22T00:00:04Z', fetchedAt: '' })).toBe(computePeriodKey({ periodEnd: '2026-11-21T23:59:51Z', fetchedAt: '' }))
    expect(computePeriodKey({ periodEnd: null, fetchedAt: '2026-11-21T05:00:00Z' })).toBe('end:2026-11-22T00:00:00.000Z')
  })
  it('redacts secrets', () => {
    const out = redact(`failed ${WEBHOOK} Authorization: Bearer abc.def.ghi ssid=xyz eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig`)
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(out).not.toContain('abc.def.ghi')
    expect(out).not.toContain('xyz')
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })
})
