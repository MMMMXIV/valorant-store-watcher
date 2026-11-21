import type { CatalogSkin, StoreSnapshot, WishlistItem } from '../types'

export interface ProviderStatus {
  ready: boolean
  /** Human readable (Japanese) status line for the UI. */
  message: string
  accountLabel?: string | null
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
