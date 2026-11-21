import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WatcherCore, buildCatalog, type FetchLike } from '../src/core'

export const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/catalog.json'), 'utf8'))
export const catalogData = () => buildCatalog(fixture.weaponsJa, fixture.weaponsEn, fixture.tiersJa, fixture.tiersEn)

export const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEFG-123'

export interface FakeDiscord {
  fetch: FetchLike
  calls: Array<{ url: string; body: any }>
  /** queue of statuses to return; when empty → 204 */
  queue: Array<number | { status: number; body?: string; headers?: Record<string, string> } | 'network'>
}

export function fakeDiscord(): FakeDiscord {
  const fd: FakeDiscord = {
    calls: [],
    queue: [],
    fetch: async (url, init) => {
      fd.calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      const next = fd.queue.shift()
      if (next === 'network') throw new TypeError('fetch failed')
      const spec = typeof next === 'number' ? { status: next } : (next ?? { status: 204 })
      return new Response(spec.status === 204 ? null : (spec.body ?? '{}'), { status: spec.status, headers: spec.headers })
    }
  }
  return fd
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vsw-test-'))
}

export interface TestApp {
  core: WatcherCore
  discord: FakeDiscord
  clock: { now: Date }
  webhook: { url: string | null }
}

export async function createTestApp(opts: { dbPath?: string | null; now?: string; seedCatalog?: boolean } = {}): Promise<TestApp> {
  const discord = fakeDiscord()
  const clock = { now: new Date(opts.now ?? '2026-11-21T00:10:00Z') }
  const webhook = { url: WEBHOOK as string | null }
  const core = await WatcherCore.create({
    dbPath: opts.dbPath ?? null,
    fetchImpl: discord.fetch,
    getWebhookUrl: async () => webhook.url,
    now: () => clock.now,
    sendOptions: { sleepFn: async () => undefined, maxAttempts: 4 }
  })
  if (opts.seedCatalog !== false && core.repos.catalog.count() === 0) core.repos.catalog.replaceAll(catalogData())
  return { core, discord, clock, webhook }
}

export const findSkin = (core: WatcherCore, nameEn: string) => {
  const s = core.repos.catalog.allSkins().find((x) => x.nameEn === nameEn)
  if (!s) throw new Error(`fixture skin not found: ${nameEn}`)
  return s
}

export const levelIdsOf = (core: WatcherCore, skinId: string, kind: 'level' | 'chroma' = 'level') =>
  core.repos.db.all<{ alias_id: string }>('SELECT alias_id FROM skin_aliases WHERE skin_id=? AND kind=?', [skinId, kind]).map((r) => r.alias_id)
