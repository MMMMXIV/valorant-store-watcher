import type { CatalogSkin, StoreSnapshot, WishlistItem } from '../types'

export interface ProviderStatus {
  ready: boolean
  /** Human readable (Japanese) status line for the UI. */
  message: string
  accountLabel?: string | null
}

/** One account's result within a multi-account fetch. */
export interface MultiFetchItem {
  key: string
  label: string
  snapshot?: StoreSnapshot
  /** Fetch failed for this account (other accounts are unaffected). */
  error?: string
  /** The failure means this account needs a manual re-login. */
  relogin?: boolean
  /** Account was intentionally skipped. */
  skipped?: 'not-logged-in' | 'relogin' | 'fresh'
}

/** A provider that can fetch several accounts' stores in one check. */
export interface MultiStoreProvider extends StoreProvider {
  fetchStores(ctx: ProviderContext, opts: { force: boolean }): Promise<MultiFetchItem[]>
}

export function isMultiStoreProvider(p: StoreProvider): p is MultiStoreProvider {
  return typeof (p as MultiStoreProvider).fetchStores === 'function'
}

export interface ProviderContext {
  now: Date
  /** Read-only access to catalog/wishlist (used by the mock provider). */
  catalog: () => CatalogSkin[]
  wishlist: () => WishlistItem[]
}

/**
 * Abstraction over "where today's personal store comes from".
 * Implementations must not bypass MFA/CAPTCHA, read game memory, or touch anti-cheat.
 */
export interface StoreProvider {
  readonly id: string
  readonly displayName: string
  /** Whether the scheduler may call fetchStore() unattended. */
  readonly supportsAutomatic: boolean
  /** Whether the provider talks to Riot services (unofficial). Shown as a risk in the UI. */
  readonly usesUnofficialRiotApi: boolean
  /** Cheap synchronous check: false → the scheduler does not run (e.g. not logged in). */
  canRunAutomatically?(): boolean
  status(ctx: ProviderContext): Promise<ProviderStatus>
  fetchStore(ctx: ProviderContext): Promise<StoreSnapshot>
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderUnavailableError'
  }
}
