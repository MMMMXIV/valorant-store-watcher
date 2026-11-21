import { describe, expect, it } from 'vitest'
import { DiscordBotClient, DiscordPermanentError, botInstallLinks, isValidBotToken, isValidUserId, type Notifier } from '../src/core'
import { createTestApp, findSkin } from './helpers'

// Obviously fake token (built at runtime so it is never mistaken for a real Discord token)
const TOKEN = ['TESTONLY'.padEnd(24, '0'), 'FAKEaa', 'x'.repeat(38)].join('.')
const USER = '123456789012345678'

function fakeDiscordApi() {
  const calls: Array<{ method: string; path: string; auth: string | null; body: any }> = []
  const queue: Array<{ status: number; body?: unknown }> = []
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace('/api/v10', '')
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ method: init?.method ?? 'GET', path, auth: headers.Authorization ?? null, body: init?.body ? JSON.parse(String(init.body)) : null })
    const q = queue.shift()
    if (q) return new Response(q.body === undefined ? '' : JSON.stringify(q.body), { status: q.status })
    if (path === '/users/@me/channels') return new Response(JSON.stringify({ id: '999000111222333444', type: 1 }), { status: 200 })
    if (path.startsWith('/channels/')) return new Response(JSON.stringify({ id: 'm1' }), { status: 200 })
    if (path === '/oauth2/applications/@me') return new Response(JSON.stringify({ id: '112345678901234567', name: 'StoreBot' }), { status: 200 })
    return new Response('{}', { status: 404 })
  }
  return { calls, queue, fetch }
}

describe('Discord BOT DM 通知', () => {
  it('opens the DM channel once, then posts messages there (no username override)', async () => {
    const d = fakeDiscordApi()
    const c = new DiscordBotClient(d.fetch, TOKEN, { sleepFn: async () => undefined })
    await c.sendDm(USER, { username: 'X', content: 'hello', embeds: [{ title: 't' }] })
    await c.sendDm(USER, { content: 'again' })
    expect(d.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'POST /users/@me/channels',
      'POST /channels/999000111222333444/messages',
      'POST /channels/999000111222333444/messages'
    ])
    expect(d.calls[0].body).toEqual({ recipient_id: USER })
    expect(d.calls[0].auth).toBe(`Bot ${TOKEN}`)
    expect(d.calls[1].body).toEqual({ content: 'hello', embeds: [{ title: 't' }] })
  })

  it('retries 429 with retry_after and 5xx, explains 50278 / invalid token', async () => {
    const d = fakeDiscordApi()
    const waits: number[] = []
    const c = new DiscordBotClient(d.fetch, TOKEN, { sleepFn: async (ms) => void waits.push(ms) })
    d.queue.push({ status: 429, body: { retry_after: 1.5 } }, { status: 502 })
    await c.sendDm(USER, { content: 'x' })
    expect(waits).toEqual([1750, 2000])

    const d2 = fakeDiscordApi()
    d2.queue.push({ status: 403, body: { code: 50278, message: 'Cannot send messages to this user due to having no mutual guilds' } })
    const c2 = new DiscordBotClient(d2.fetch, TOKEN, { sleepFn: async () => undefined })
    await expect(c2.sendDm(USER, { content: 'x' })).rejects.toThrow(/共通のサーバー/)
    expect(d2.calls).toHaveLength(1)

    const d3 = fakeDiscordApi()
    d3.queue.push({ status: 401, body: { message: '401: Unauthorized', code: 0 } })
    await expect(new DiscordBotClient(d3.fetch, TOKEN).sendDm(USER, { content: 'x' })).rejects.toBeInstanceOf(DiscordPermanentError)
  })

  it('validates input and builds install links', async () => {
    expect(isValidBotToken(TOKEN)).toBe(true)
    expect(isValidBotToken('abc')).toBe(false)
    expect(isValidUserId(USER)).toBe(true)
    expect(isValidUserId('12ab')).toBe(false)
    const l = botInstallLinks('112345678901234567')
    expect(l.userInstall).toContain('integration_type=1')
    expect(l.serverInvite).toContain('integration_type=0')
    const d = fakeDiscordApi()
    expect(await new DiscordBotClient(d.fetch, TOKEN).application()).toEqual({ id: '112345678901234567', name: 'StoreBot' })
  })

  it('pipeline: wishlist hit → BOT DM with image embed, deduped like the webhook', async () => {
    const { core, discord } = await createTestApp()
    const d = fakeDiscordApi()
    const client = new DiscordBotClient(d.fetch, TOKEN, { sleepFn: async () => undefined })
    const notifier: Notifier = { kind: 'bot', send: (p) => client.sendDm(USER, p) }
    ;(core.checkService as any).deps.getNotifier = async () => notifier
    const s = findSkin(core, 'RGX 11z Pro Vandal')
    core.repos.wishlist.add(s.id, 'high')
    core.repos.settings.update({ providerId: 'mock', mockForceWishlistHit: true })
    const r1 = await core.checkService.runCheck('manual')
    const r2 = await core.checkService.runCheck('manual')
    expect([r1.notified, r2.notified]).toEqual([1, 0])
    const msgs = d.calls.filter((c) => c.path.endsWith('/messages'))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].body.embeds[0].title).toContain(s.nameJa)
    expect(msgs[0].body.embeds[0].image.url).toMatch(/^https:\/\/media\.valorant-api\.com\//)
    expect(msgs[0].body.username).toBeUndefined()
    expect(discord.calls).toHaveLength(0) // webhook not used
    const t = await core.checkService.sendTest()
    expect(t).toMatchObject({ ok: true })
    expect(t.message).toContain('DM')
  })
})
