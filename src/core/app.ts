import { AppDatabase } from './db/Database'
import { createRepos, type Repos } from './db/repositories'
import { CatalogService } from './catalog/CatalogService'
import { ValorantApiClient } from './catalog/valorantApi'
import { MockStoreProvider } from './providers/MockStoreProvider'
import { ManualFileProvider, ManualPasteProvider } from './providers/ManualImport'
import type { StoreProvider } from './providers/StoreProvider'
import { StoreCheckService } from './monitor/StoreCheckService'
import { MonitorScheduler, type CheckPlan } from './monitor/Scheduler'
import type { FetchLike } from './util/http'
import type { SendOptions } from './notify/discord'

export interface WatcherCoreOptions {
  dbPath: string | null
  wasmPath?: string
  fetchImpl: FetchLike
  getWebhookUrl: () => Promise<string | null>
  now?: () => Date
  sendOptions?: SendOptions
  tickMs?: number
  onChange?: () => void
  onPlan?: (p: CheckPlan | null) => void
}

/**
 * Wires everything together. Used by the Electron main process AND the headless runner,
 * which is what makes moving to a server/headless deployment possible later.
 */
export class WatcherCore {
  readonly catalogService: CatalogService
  readonly checkService: StoreCheckService
  readonly scheduler: MonitorScheduler
  readonly mock: MockStoreProvider
  private providers: Record<string, StoreProvider>

  private constructor(
    readonly repos: Repos,
    private opts: WatcherCoreOptions
  ) {
    const s = repos.settings.get()
    this.mock = new MockStoreProvider({ seed: s.mockSeed, forceWishlistHit: s.mockForceWishlistHit }, (id) => this.firstLevelId(id))
    this.providers = {
      mock: this.mock,
      manual: new ManualPasteProvider(),
      'manual-file': new ManualFileProvider(() => repos.settings.get().manualFilePath)
    }
    this.catalogService = new CatalogService(repos.catalog, repos.meta, new ValorantApiClient(opts.fetchImpl))
    this.checkService = new StoreCheckService({
      repos,
      getProvider: () => this.provider,
      getWebhookUrl: opts.getWebhookUrl,
      fetchImpl: opts.fetchImpl,
      now: opts.now,
      sendOptions: opts.sendOptions,
      onChange: opts.onChange
    })
    this.scheduler = new MonitorScheduler({
      service: this.checkService,
      getSettings: () => repos.settings.get(),
      getState: () => repos.monitor.get(),
      supportsAutomatic: () => this.provider.supportsAutomatic,
      now: opts.now,
      tickMs: opts.tickMs,
      onPlan: opts.onPlan
    })
    repos.runs.recoverInterrupted()
  }

  static async create(opts: WatcherCoreOptions): Promise<WatcherCore> {
    const db = await AppDatabase.open(opts.dbPath, { wasmPath: opts.wasmPath })
    return new WatcherCore(createRepos(db), opts)
  }

  get provider(): StoreProvider {
    const s = this.repos.settings.get()
    this.mock.options.seed = s.mockSeed
    this.mock.options.forceWishlistHit = s.mockForceWishlistHit
    return this.providers[s.providerId] ?? this.mock
  }

  /** Non-secret Riot account info (puuid, Riot ID, region) kept in the DB meta table. */
  loadRiotAccount(): { puuid: string; gameName: string | null; region: string | null } | null {
    const raw = this.repos.meta.get('riot_account')
    try {
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  saveRiotAccount(a: { puuid: string; gameName: string | null; region: string | null } | null): void {
    this.repos.meta.set('riot_account', a ? JSON.stringify(a) : null)
  }

  /** X-Riot-ClientVersion from Valorant-API (/v1/version), cached in meta by the catalog updater. */
  async riotClientVersion(): Promise<string> {
    const cached = this.repos.meta.get('riot_client_version')
    if (cached) return cached
    const v = await this.catalogService.fetchVersion()
    this.repos.meta.set('riot_client_version', v.riotClientVersion)
    return v.riotClientVersion
  }

  registerProvider(p: StoreProvider): void {
    this.providers[p.id] = p
  }

  private firstLevelId(skinId: string): string | null {
    const r = this.repos.db.get<{ alias_id: string }>("SELECT alias_id FROM skin_aliases WHERE skin_id = ? AND kind = 'level' ORDER BY rowid LIMIT 1", [skinId])
    return r?.alias_id ?? null
  }

  close(): void {
    this.scheduler.stop()
    this.repos.db.close()
  }
}
