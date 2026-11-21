import type { CatalogSkin } from './api'
import { normalizeName } from '../../../core/util/ids'

/** Same matching rules as the core search: ja + en names, width/case-insensitive, all terms must match. */
export function searchSkinsUi(skins: CatalogSkin[], query: string, weaponId: string | null): CatalogSkin[] {
  const terms = normalizeName(query).split(' ').filter(Boolean)
  return skins.filter((s) => {
    if (weaponId && s.weaponId !== weaponId) return false
    if (!terms.length) return true
    const hay = normalizeName(`${s.nameJa} ${s.nameEn} ${s.weaponNameJa} ${s.weaponNameEn}`)
    return terms.every((t) => hay.includes(t))
  })
}
