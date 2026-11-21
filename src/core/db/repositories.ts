import type { AppDatabase } from './Database'
import { DEFAULT_SETTINGS, SettingsSchema, type Settings, type SettingsPatch } from '../settings'
import type {
  AliasKind,
  CatalogSkin,
  CheckRun,
  CheckTrigger,
  ContentTier,
  ErrorLogEntry,
  MonitorState,
  NotificationKind,
  NotificationRecord,
  Priority,
  ResolvedOffer,
  StoredSnapshot,
  Weapon,
  WishlistItem
} from '../types'
import { normalizeUuid } from '../util/ids'
import { redact } from '../util/redact'

const nowIso = (): string => new Date().toISOString()

export class SettingsRepo {
  constructor(private db: AppDatabase) {}

  get(): Settings {
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings')
    const raw: Record<string, unknown> = {}
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.value)
      } catch {
        /* ignore corrupted value */
      }
    }
    const parsed = SettingsSchema.safeParse(raw)
    if (parsed.success) return parsed.data
    // keep valid keys only
    const result: Settings = { ...DEFAULT_SETTINGS }
    for (const [k, v] of Object.entries(raw)) {
      const one = SettingsSchema.shape[k as keyof Settings]?.safeParse(v)
      if (one?.success) (result as Record<string, unknown>)[k] = one.data
    }
    return result
  }

  update(patch: SettingsPatch): Settings {
    const merged = SettingsSchema.parse({ ...this.get(), ...patch })
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(patch)) {
        this.db.run('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)', [k, JSON.stringify((merged as Record<string, unknown>)[k])])
      }
    })
    return merged
  }
}

export class MetaRepo {
  constructor(private db: AppDatabase) {}
  get(key: string): string | null {
    return this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value ?? null
  }
  set(key: string, value: string | null): void {
    if (value === null) this.db.run('DELETE FROM meta WHERE key = ?', [key])
    else this.db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [key, value])
  }
}

interface SkinRow {
  id: string
  weapon_id: string
  name_ja: string
  name_en: string
  tier_id: string | null
  icon_url: string | null
  render_url: string | null
  removed: number
  w_name_ja: string | null
  w_name_en: string | null
  t_name: string | null
  t_dev: string | null
  t_rank: number | null
  t_color: string | null
}

const SKIN_SELECT = `
  SELECT s.*, w.name_ja AS w_name_ja, w.name_en AS w_name_en,
         t.name_ja AS t_name, t.dev_name AS t_dev, t.rank AS t_rank, t.color AS t_color
  FROM skins s
  LEFT JOIN weapons w ON w.id = s.weapon_id
  LEFT JOIN tiers t ON t.id = s.tier_id`

function toSkin(r: SkinRow): CatalogSkin {
  return {
    id: r.id,
    weaponId: r.weapon_id,
    weaponNameJa: r.w_name_ja ?? '',
    weaponNameEn: r.w_name_en ?? '',
    nameJa: r.name_ja,
    nameEn: r.name_en,
    tierId: r.tier_id,
    tierName: r.t_name,
    tierDevName: r.t_dev,
    tierRank: r.t_rank,
    tierColor: r.t_color,
    iconUrl: r.icon_url,
    renderUrl: r.render_url,
    removed: r.removed === 1
  }
}

export interface CatalogUpsert {
  weapons: Weapon[]
  tiers: ContentTier[]
  skins: Array<Omit<CatalogSkin, 'weaponNameJa' | 'weaponNameEn' | 'tierName' | 'tierDevName' | 'tierRank' | 'tierColor' | 'removed'> & {
    aliases: Array<{ id: string; kind: AliasKind }>
  }>
}

export class CatalogRepo {
  constructor(private db: AppDatabase) {}

  count(): number {
    return Number(this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM skins WHERE removed = 0')?.c ?? 0)
  }

  weapons(): Weapon[] {
    return this.db
      .all<{ id: string; name_ja: string; name_en: string; category: string; sort_order: number }>('SELECT * FROM weapons ORDER BY sort_order')
      .map((r) => ({ id: r.id, nameJa: r.name_ja, nameEn: r.name_en, category: r.category, sortOrder: r.sort_order }))
  }

  tiers(): ContentTier[] {
    return this.db
      .all<{ id: string; name_ja: string; name_en: string; dev_name: string; rank: number; color: string }>('SELECT * FROM tiers ORDER BY rank')
      .map((r) => ({ id: r.id, nameJa: r.name_ja, nameEn: r.name_en, devName: r.dev_name, rank: r.rank, color: r.color }))
  }

  allSkins(includeRemoved = false): CatalogSkin[] {
    return this.db
      .all<SkinRow>(`${SKIN_SELECT} ${includeRemoved ? '' : 'WHERE s.removed = 0'} ORDER BY w.sort_order, s.name_ja`)
      .map(toSkin)
  }

  getSkin(id: string): CatalogSkin | null {
    const r = this.db.get<SkinRow>(`${SKIN_SELECT} WHERE s.id = ?`, [id])
    return r ? toSkin(r) : null
  }

  /** Resolves any skin / level / chroma uuid to its base skin id. */
  resolveSkinId(anyId: string): string | null {
    const id = normalizeUuid(anyId)
    if (!id) return null
    return this.db.get<{ skin_id: string }>('SELECT skin_id FROM skin_aliases WHERE alias_id = ?', [id])?.skin_id ?? null
  }

  findByName(name: string): CatalogSkin[] {
    return this.db
      .all<SkinRow>(`${SKIN_SELECT} WHERE s.removed = 0 AND (lower(s.name_ja) = lower(?) OR lower(s.name_en) = lower(?))`, [name, name])
      .map(toSkin)
  }

  /**
   * Replaces catalog contents. Skins missing from the new data are flagged
   * `removed` (never deleted) so wishlist/history references stay valid.
   */
  replaceAll(data: CatalogUpsert): { added: number; updated: number; removed: number } {
    return this.db.transaction(() => {
      const existing = new Set(this.db.all<{ id: string }>('SELECT id FROM skins').map((r) => r.id))
      const at = nowIso()
      this.db.run('DELETE FROM weapons')
      for (const w of data.weapons) {
        this.db.run('INSERT INTO weapons(id, name_ja, name_en, category, sort_order) VALUES (?,?,?,?,?)', [w.id, w.nameJa, w.nameEn, w.category, w.sortOrder])
      }
      this.db.run('DELETE FROM tiers')
      for (const t of data.tiers) {
        this.db.run('INSERT INTO tiers(id, name_ja, name_en, dev_name, rank, color) VALUES (?,?,?,?,?,?)', [t.id, t.nameJa, t.nameEn, t.devName, t.rank, t.color])
      }
      let added = 0
      let updated = 0
      const seen = new Set<string>()
      for (const s of data.skins) {
        seen.add(s.id)
        if (existing.has(s.id)) updated++
        else added++
        this.db.run(
          `INSERT INTO skins(id, weapon_id, name_ja, name_en, tier_id, icon_url, render_url, removed, updated_at)
           VALUES (?,?,?,?,?,?,?,0,?)
           ON CONFLICT(id) DO UPDATE SET weapon_id=excluded.weapon_id, name_ja=excluded.name_ja, name_en=excluded.name_en,
             tier_id=excluded.tier_id, icon_url=excluded.icon_url, render_url=excluded.render_url, removed=0, updated_at=excluded.updated_at`,
          [s.id, s.weaponId, s.nameJa, s.nameEn, s.tierId, s.iconUrl, s.renderUrl, at]
        )
        this.db.run('INSERT OR REPLACE INTO skin_aliases(alias_id, skin_id, kind) VALUES (?,?,?)', [s.id, s.id, 'skin'])
        for (const a of s.aliases) {
          this.db.run('INSERT OR REPLACE INTO skin_aliases(alias_id, skin_id, kind) VALUES (?,?,?)', [a.id, s.id, a.kind])
        }
      }
      let removed = 0
      for (const id of existing) {
        if (!seen.has(id)) {
          removed += this.db.run('UPDATE skins SET removed = 1 WHERE id = ? AND removed = 0', [id]).changes
        }
      }
      return { added, updated, removed }
    })
  }
}

export class WishlistRepo {
  constructor(
    private db: AppDatabase,
    private catalog: CatalogRepo
  ) {}

  list(): WishlistItem[] {
    return this.db
      .all<{ skin_id: string; priority: Priority; position: number; added_at: string }>('SELECT * FROM wishlist ORDER BY position')
      .map((r) => ({ skinId: r.skin_id, priority: r.priority, position: r.position, addedAt: r.added_at, skin: this.catalog.getSkin(r.skin_id) }))
  }

  has(skinId: string): boolean {
    return !!this.db.get('SELECT 1 FROM wishlist WHERE skin_id = ?', [skinId])
  }

  /** Adds a skin. Accepts skin/level/chroma id; always stores the BASE skin id. */
  add(anyId: string, priority: Priority = 'normal'): WishlistItem {
    const skinId = this.catalog.resolveSkinId(anyId)
    if (!skinId) throw new Error('カタログに存在しないスキンIDです')
    if (!this.has(skinId)) {
      const max = Number(this.db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM wishlist')?.m ?? -1)
      this.db.run('INSERT INTO wishlist(skin_id, priority, position, added_at) VALUES (?,?,?,?)', [skinId, priority, max + 1, nowIso()])
    }
    return this.list().find((w) => w.skinId === skinId)!
  }

  remove(anyId: string): boolean {
    const skinId = this.catalog.resolveSkinId(anyId) ?? normalizeUuid(anyId)
    if (!skinId) return false
    const ok = this.db.run('DELETE FROM wishlist WHERE skin_id = ?', [skinId]).changes > 0
    if (ok) this.compact()
    return ok
  }

  setPriority(skinId: string, priority: Priority): void {
    this.db.run('UPDATE wishlist SET priority = ? WHERE skin_id = ?', [priority, skinId])
  }

  /** Reorders using the full ordered list of skin ids. Unknown ids are ignored; missing ones keep relative order at the end. */
  reorder(orderedIds: string[]): void {
    const current = this.list().map((w) => w.skinId)
    const set = new Set(current)
    const head = orderedIds.filter((id, i) => set.has(id) && orderedIds.indexOf(id) === i)
    const tail = current.filter((id) => !head.includes(id))
    this.db.transaction(() => {
      ;[...head, ...tail].forEach((id, i) => this.db.run('UPDATE wishlist SET position = ? WHERE skin_id = ?', [i, id]))
    })
  }

  private compact(): void {
    this.reorder(this.list().map((w) => w.skinId))
  }
}

export class StoreRepo {
  constructor(
    private db: AppDatabase,
    private catalog: CatalogRepo
  ) {}

  /** Inserts or replaces the snapshot for (account, period). Returns the stored id. */
  save(s: Omit<StoredSnapshot, 'id' | 'offers'>, offers: ResolvedOffer[]): number {
    return this.db.transaction(() => {
      const existing = this.db.get<{ id: number }>('SELECT id FROM store_snapshots WHERE account_id = ? AND period_key = ?', [s.accountId, s.periodKey])
      let id: number
      if (existing) {
        id = existing.id
        this.db.run('UPDATE store_snapshots SET account_name=?, period_start=?, period_end=?, fetched_at=?, source=? WHERE id=?', [
          s.accountName,
          s.periodStart,
          s.periodEnd,
          s.fetchedAt,
          s.source,
          id
        ])
        this.db.run('DELETE FROM store_offers WHERE snapshot_id = ?', [id])
      } else {
        id = this.db.run(
          'INSERT INTO store_snapshots(account_id, account_name, period_key, period_start, period_end, fetched_at, source) VALUES (?,?,?,?,?,?,?)',
          [s.accountId, s.accountName, s.periodKey, s.periodStart, s.periodEnd, s.fetchedAt, s.source]
        ).lastId
      }
      for (const o of offers) {
        this.db.run('INSERT INTO store_offers(snapshot_id, slot, raw_item_id, skin_id, price, currency_id) VALUES (?,?,?,?,?,?)', [
          id,
          o.slot,
          o.rawItemId,
          o.skinId,
          o.price,
          o.currencyId
        ])
      }
      return id
    })
  }

  list(limit = 60): StoredSnapshot[] {
    const rows = this.db.all<{
      id: number
      account_id: string
      account_name: string | null
      period_key: string
      period_start: string | null
      period_end: string | null
      fetched_at: string
      source: string
    }>('SELECT * FROM store_snapshots ORDER BY fetched_at DESC LIMIT ?', [limit])
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      accountName: r.account_name,
      periodKey: r.period_key,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      fetchedAt: r.fetched_at,
      source: r.source,
      offers: this.offers(r.id)
    }))
  }

  latest(source?: string): StoredSnapshot | null {
    if (!source) return this.list(1)[0] ?? null
    const r = this.db.get<{ id: number }>('SELECT id FROM store_snapshots WHERE source = ? ORDER BY fetched_at DESC LIMIT 1', [source])
    return r ? (this.list(500).find((s) => s.id === r.id) ?? null) : null
  }

  offers(snapshotId: number): ResolvedOffer[] {
    return this.db
      .all<{ slot: number; raw_item_id: string | null; skin_id: string | null; price: number | null; currency_id: string | null }>(
        'SELECT * FROM store_offers WHERE snapshot_id = ? ORDER BY slot',
        [snapshotId]
      )
      .map((o) => ({
        slot: o.slot,
        rawItemId: o.raw_item_id,
        skinId: o.skin_id,
        price: o.price,
        currencyId: o.currency_id,
        skin: o.skin_id ? this.catalog.getSkin(o.skin_id) : null
      }))
  }

  /** How many times each skin has appeared (history stats). */
  appearanceStats(limit = 100): Array<{ skinId: string; count: number; lastSeen: string; skin: CatalogSkin | null }> {
    return this.db
      .all<{ skin_id: string; c: number; last: string }>(
        `SELECT o.skin_id, COUNT(*) AS c, MAX(s.fetched_at) AS last FROM store_offers o
         JOIN store_snapshots s ON s.id = o.snapshot_id WHERE o.skin_id IS NOT NULL
         GROUP BY o.skin_id ORDER BY last DESC LIMIT ?`,
        [limit]
      )
      .map((r) => ({ skinId: r.skin_id, count: r.c, lastSeen: r.last, skin: this.catalog.getSkin(r.skin_id) }))
  }
}

export class NotificationRepo {
  constructor(
    private db: AppDatabase,
    private catalog: CatalogRepo
  ) {}

  /** True if a notification for this key was already sent successfully. */
  wasSent(accountId: string, periodKey: string, skinId: string, kind: NotificationKind): boolean {
    return !!this.db.get("SELECT 1 FROM notifications WHERE account_id=? AND period_key=? AND skin_id=? AND kind=? AND status='sent'", [
      accountId,
      periodKey,
      skinId,
      kind
    ])
  }

  record(accountId: string, periodKey: string, skinId: string, kind: NotificationKind, ok: boolean, attempts: number, error: string | null): void {
    const at = nowIso()
    this.db.run(
      `INSERT INTO notifications(account_id, period_key, skin_id, kind, status, created_at, sent_at, attempts, error)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(account_id, period_key, skin_id, kind) DO UPDATE SET
         status=excluded.status, sent_at=COALESCE(excluded.sent_at, notifications.sent_at),
         attempts=notifications.attempts + excluded.attempts, error=excluded.error`,
      [accountId, periodKey, skinId, kind, ok ? 'sent' : 'failed', at, ok ? at : null, attempts, error ? redact(error) : null]
    )
  }

  list(limit = 200): NotificationRecord[] {
    return this.db
      .all<{
        id: number
        account_id: string
        period_key: string
        skin_id: string
        kind: NotificationKind
        status: 'sent' | 'failed'
        created_at: string
        sent_at: string | null
        attempts: number
        error: string | null
      }>('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', [limit])
      .map((r) => ({
        id: r.id,
        accountId: r.account_id,
        periodKey: r.period_key,
        skinId: r.skin_id,
        kind: r.kind,
        status: r.status,
        createdAt: r.created_at,
        sentAt: r.sent_at,
        attempts: r.attempts,
        error: r.error,
        skinName: r.skin_id ? (this.catalog.getSkin(r.skin_id)?.nameJa ?? null) : null
      }))
  }

  countSent(kind?: NotificationKind): number {
    return Number(
      this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM notifications WHERE status='sent' ${kind ? 'AND kind = ?' : ''}`, kind ? [kind] : [])?.c ?? 0
    )
  }
}

export class RunRepo {
  constructor(private db: AppDatabase) {}

  start(trigger: CheckTrigger, provider: string): number {
    return this.db.run("INSERT INTO check_runs(started_at, trigger, status, provider) VALUES (?,?,'running',?)", [nowIso(), trigger, provider]).lastId
  }

  finish(id: number, r: { status: CheckRun['status']; periodKey?: string | null; matched?: number; notified?: number; message?: string | null }): void {
    this.db.run('UPDATE check_runs SET finished_at=?, status=?, period_key=?, matched_count=?, notified_count=?, message=? WHERE id=?', [
      nowIso(),
      r.status,
      r.periodKey ?? null,
      r.matched ?? 0,
      r.notified ?? 0,
      r.message ? redact(r.message) : null,
      id
    ])
  }

  list(limit = 100): CheckRun[] {
    return this.db
      .all<{
        id: number
        started_at: string
        finished_at: string | null
        trigger: CheckTrigger
        status: CheckRun['status']
        provider: string
        period_key: string | null
        matched_count: number
        notified_count: number
        message: string | null
      }>('SELECT * FROM check_runs ORDER BY id DESC LIMIT ?', [limit])
      .map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        trigger: r.trigger,
        status: r.status,
        provider: r.provider,
        periodKey: r.period_key,
        matchedCount: r.matched_count,
        notifiedCount: r.notified_count,
        message: r.message
      }))
  }

  /** Latest finished run for a provider (manual/auto/startup/retry). */
  lastFor(provider: string): CheckRun | null {
    return this.list(300).find((r) => r.provider === provider && r.status !== 'running') ?? null
  }

  /** Marks runs left 'running' by a crash as errors. */
  recoverInterrupted(): number {
    return this.db.run("UPDATE check_runs SET status='error', finished_at=?, message='アプリ終了により中断されました' WHERE status='running'", [nowIso()])
      .changes
  }
}

export class ErrorRepo {
  constructor(private db: AppDatabase) {}
  add(source: string, message: unknown): void {
    this.db.run('INSERT INTO error_log(at, source, message) VALUES (?,?,?)', [nowIso(), source, redact(message)])
    this.db.run('DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY id DESC LIMIT 500)')
  }
  list(limit = 200): ErrorLogEntry[] {
    return this.db.all<ErrorLogEntry>('SELECT id, at, source, message FROM error_log ORDER BY id DESC LIMIT ?', [limit])
  }
}

const MONITOR_KEY = 'monitor_state'
export const EMPTY_MONITOR_STATE: MonitorState = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastPeriodKey: null,
  lastPeriodEnd: null,
  lastError: null,
  lastErrorAt: null,
  consecutiveFailures: 0
}

export class MonitorStateRepo {
  constructor(private meta: MetaRepo) {}
  get(): MonitorState {
    const raw = this.meta.get(MONITOR_KEY)
    if (!raw) return { ...EMPTY_MONITOR_STATE }
    try {
      return { ...EMPTY_MONITOR_STATE, ...(JSON.parse(raw) as Partial<MonitorState>) }
    } catch {
      return { ...EMPTY_MONITOR_STATE }
    }
  }
  set(patch: Partial<MonitorState>): MonitorState {
    const next = { ...this.get(), ...patch }
    if (next.lastError) next.lastError = redact(next.lastError)
    this.meta.set(MONITOR_KEY, JSON.stringify(next))
    return next
  }
}

/** Convenience bundle of all repositories. */
export function createRepos(db: AppDatabase) {
  const catalog = new CatalogRepo(db)
  const meta = new MetaRepo(db)
  return {
    db,
    settings: new SettingsRepo(db),
    meta,
    catalog,
    wishlist: new WishlistRepo(db, catalog),
    stores: new StoreRepo(db, catalog),
    notifications: new NotificationRepo(db, catalog),
    runs: new RunRepo(db),
    errors: new ErrorRepo(db),
    monitor: new MonitorStateRepo(meta)
  }
}
export type Repos = ReturnType<typeof createRepos>
