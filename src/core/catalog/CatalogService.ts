import type { CatalogRepo, CatalogUpsert, MetaRepo } from '../db/repositories'
import type { CatalogSkin, ContentTier, Weapon } from '../types'
import { normalizeName, normalizeUuid } from '../util/ids'
import type { ApiContentTier, ApiWeapon, ValorantApiClient } from './valorantApi'

/** Display order for weapon filter chips (English names from Valorant-API). */
const WEAPON_ORDER = [
  'Vandal', 'Phantom', 'Operator', 'Sheriff', 'Melee', 'Classic', 'Ghost', 'Frenzy', 'Shorty', 'Bandit',
  'Spectre', 'Stinger', 'Bulldog', 'Guardian', 'Marshal', 'Outlaw', 'Judge', 'Bucky', 'Ares', 'Odin'
]

const META_VERSION = 'catalog_version'
const META_UPDATED = 'catalog_updated_at'

export interface CatalogStatus {
  skinCount: number
  version: string | null
  updatedAt: string | null
}

/** Builds the normalized catalog from Valorant-API payloads (pure function, unit-tested). */
export function buildCatalog(weaponsJa: ApiWeapon[], weaponsEn: ApiWeapon[], tiersJa: ApiContentTier[], tiersEn: ApiContentTier[]): CatalogUpsert {
  const enWeapon = new Map(weaponsEn.map((w) => [w.uuid.toLowerCase(), w]))
  const enSkin = new Map<string, string>()
  for (const w of weaponsEn) for (const s of w.skins) enSkin.set(s.uuid.toLowerCase(), s.displayName)
  const enTier = new Map(tiersEn.map((t) => [t.uuid.toLowerCase(), t.displayName]))

  const weapons: Weapon[] = []
  const skins: CatalogUpsert['skins'] = []
  for (const w of weaponsJa) {
    const id = normalizeUuid(w.uuid)
    if (!id) continue
    const en = enWeapon.get(id)
    const nameEn = en?.displayName ?? w.displayName
    const idx = WEAPON_ORDER.indexOf(nameEn)
    weapons.push({ id, nameJa: w.displayName, nameEn, category: w.category.replace('EEquippableCategory::', ''), sortOrder: idx === -1 ? 100 : idx })
    const defaultSkin = normalizeUuid(w.defaultSkinUuid)
    for (const s of w.skins) {
      const sid = normalizeUuid(s.uuid)
      if (!sid || sid === defaultSkin) continue
      // "Random favorite skin" placeholder entries are not real skins
      if (/random/i.test(s.assetPath ?? '')) continue
      const aliases: Array<{ id: string; kind: 'level' | 'chroma' }> = []
      for (const l of s.levels ?? []) {
        const lid = normalizeUuid(l.uuid)
        if (lid && lid !== sid) aliases.push({ id: lid, kind: 'level' })
      }
      for (const c of s.chromas ?? []) {
        const cid = normalizeUuid(c.uuid)
        if (cid && cid !== sid) aliases.push({ id: cid, kind: 'chroma' })
      }
      const firstChroma = s.chromas?.[0]
      const icon = s.displayIcon ?? s.levels?.[0]?.displayIcon ?? firstChroma?.fullRender ?? firstChroma?.displayIcon ?? null
      skins.push({
        id: sid,
        weaponId: id,
        nameJa: s.displayName,
        nameEn: enSkin.get(sid) ?? s.displayName,
        tierId: normalizeUuid(s.contentTierUuid),
        iconUrl: icon,
        renderUrl: firstChroma?.fullRender ?? icon,
        aliases
      })
    }
  }
  const tiers: ContentTier[] = tiersJa
    .map((t) => ({
      id: t.uuid.toLowerCase(),
      nameJa: t.displayName,
      nameEn: enTier.get(t.uuid.toLowerCase()) ?? t.devName,
      devName: t.devName,
      rank: t.rank,
      color: `#${(t.highlightColor ?? 'ffffff').slice(0, 6)}`
    }))
    .sort((a, b) => a.rank - b.rank)
  return { weapons: weapons.sort((a, b) => a.sortOrder - b.sortOrder), tiers, skins }
}

export class CatalogService {
  private updating: Promise<CatalogStatus> | null = null

  constructor(
    private repo: CatalogRepo,
    private meta: MetaRepo,
    private api: ValorantApiClient
  ) {}

  status(): CatalogStatus {
    return { skinCount: this.repo.count(), version: this.meta.get(META_VERSION), updatedAt: this.meta.get(META_UPDATED) }
  }

  /** True if the cache is empty or older than maxAgeHours. */
  isStale(maxAgeHours = 24, now = new Date()): boolean {
    const at = this.meta.get(META_UPDATED)
    if (!at || this.repo.count() === 0) return true
    return now.getTime() - new Date(at).getTime() > maxAgeHours * 3600_000
  }

  /**
   * Updates the catalog. With force=false the (small) /v1/version endpoint is checked first and
   * the large weapons payload is only downloaded when the game version changed.
   */
  update(force = false): Promise<CatalogStatus> {
    if (!this.updating) {
      this.updating = this.doUpdate(force).finally(() => {
        this.updating = null
      })
    }
    return this.updating
  }

  fetchVersion() {
    return this.api.version()
  }

  private async doUpdate(force: boolean): Promise<CatalogStatus> {
    const version = await this.api.version()
    this.meta.set('riot_client_version', version.riotClientVersion)
    const versionKey = `${version.version}|${version.manifestId}`
    if (!force && this.repo.count() > 0 && this.meta.get(META_VERSION) === versionKey) {
      this.meta.set(META_UPDATED, new Date().toISOString())
      return this.status()
    }
    const [wJa, wEn, tJa, tEn] = await Promise.all([
      this.api.weapons('ja-JP'),
      this.api.weapons('en-US'),
      this.api.contentTiers('ja-JP'),
      this.api.contentTiers('en-US')
    ])
    const data = buildCatalog(wJa, wEn, tJa, tEn)
    if (data.skins.length < 50) throw new Error('取得したスキン数が少なすぎるため、カタログ更新を中止しました')
    this.repo.replaceAll(data)
    this.meta.set(META_VERSION, versionKey)
    this.meta.set(META_UPDATED, new Date().toISOString())
    this.meta.set('riot_client_version', version.riotClientVersion)
    return this.status()
  }
}

/** Search across Japanese and English names (case/width-insensitive). */
export function searchSkins(skins: CatalogSkin[], query: string, weaponId?: string | null): CatalogSkin[] {
  const q = normalizeName(query)
  const terms = q ? q.split(' ') : []
  return skins.filter((s) => {
    if (weaponId && s.weaponId !== weaponId) return false
    if (!terms.length) return true
    const hay = normalizeName(`${s.nameJa} ${s.nameEn} ${s.weaponNameJa} ${s.weaponNameEn}`)
    return terms.every((t) => hay.includes(t))
  })
}
