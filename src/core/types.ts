/** Shared domain types. This module must stay free of Electron/DOM dependencies. */

export type Priority = 'high' | 'normal' | 'low'

export interface Weapon {
  id: string
  nameJa: string
  nameEn: string
  category: string
  sortOrder: number
}

export interface ContentTier {
  id: string
  nameJa: string
  nameEn: string
  devName: string
  rank: number
  color: string
}

export interface CatalogSkin {
  id: string // base skin uuid (normalized)
  weaponId: string
  weaponNameJa: string
  weaponNameEn: string
  nameJa: string
  nameEn: string
  tierId: string | null
  tierName: string | null
  tierDevName: string | null
  tierRank: number | null
  tierColor: string | null
  iconUrl: string | null
  renderUrl: string | null
  removed: boolean
}

export type AliasKind = 'skin' | 'level' | 'chroma'

export interface WishlistItem {
  skinId: string
  priority: Priority
  position: number
  addedAt: string
  skin: CatalogSkin | null
}

export interface StoreOfferInput {
  /** Raw item id as given by the source (often a skin LEVEL uuid). */
  itemId?: string
  /** Fallback for manual input only: exact skin name (ja or en). */
  name?: string
  price?: number | null
  currencyId?: string | null
}

export interface StoreSnapshot {
  accountId: string
  accountName?: string | null
  fetchedAt: string // ISO
  periodStart?: string | null
  periodEnd?: string | null // = next store refresh, when known
  source: string // provider id
  offers: StoreOfferInput[]
}

export interface ResolvedOffer {
  slot: number
  rawItemId: string | null
  skinId: string | null
  price: number | null
  currencyId: string | null
  skin: CatalogSkin | null
}

export interface StoredSnapshot {
  id: number
  accountId: string
  accountName: string | null
  periodKey: string
  periodStart: string | null
  periodEnd: string | null
  fetchedAt: string
  source: string
  offers: ResolvedOffer[]
}

export interface MatchResult {
  offer: ResolvedOffer
  wish: WishlistItem
}

export type NotificationKind = 'wishlist' | 'daily' | 'error' | 'test'

export interface NotificationRecord {
  id: number
  accountId: string
  periodKey: string
  skinId: string
  kind: NotificationKind
  status: 'sent' | 'failed'
  createdAt: string
  sentAt: string | null
  attempts: number
  error: string | null
  skinName: string | null
}

export interface CheckRun {
  id: number
  startedAt: string
  finishedAt: string | null
  trigger: CheckTrigger
  status: 'success' | 'error' | 'skipped' | 'running'
  provider: string
  periodKey: string | null
  matchedCount: number
  notifiedCount: number
  message: string | null
}

export type CheckTrigger = 'auto' | 'manual' | 'startup' | 'retry' | 'import' | 'headless'

export interface ErrorLogEntry {
  id: number
  at: string
  source: string
  message: string
}

export interface MonitorState {
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastPeriodKey: string | null
  lastPeriodEnd: string | null
  lastError: string | null
  lastErrorAt: string | null
  consecutiveFailures: number
}

export const VP_CURRENCY_ID = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741'
