import type { CookieJar } from '../../src/core'
import type { SecretBox } from './crypto'

export interface ServerRiotAccount {
  key: string
  label: string
  puuid: string | null
  gameName: string | null
  region: string | null
  regionOverride: string
  lastPeriodEnd: string | null
  /** Encrypted cookie jar (never stored in plaintext). */
  encCookies: string | null
  needsRelogin: boolean
}

export interface ServerUser {
  discordUserId: string
  consentedAt: string | null
  consentVersion: string | null
  pushToken: string | null
  accounts: ServerRiotAccount[]
  wishlistSkinIds: string[]
}

/**
 * Persistence interface for the server. A real deployment implements this on SQLite/Postgres;
 * tests use an in-memory version. Cookies are encrypted by the caller (SecretBox).
 */
export interface UserStore {
  getUser(discordUserId: string): ServerUser | null
  upsertUser(user: ServerUser): void
  deleteUser(discordUserId: string): void
  allUsers(): ServerUser[]
}

export class InMemoryUserStore implements UserStore {
  private users = new Map<string, ServerUser>()
  getUser(id: string): ServerUser | null {
    return this.users.get(id) ?? null
  }
  upsertUser(u: ServerUser): void {
    this.users.set(u.discordUserId, u)
  }
  deleteUser(id: string): void {
    this.users.delete(id)
  }
  allUsers(): ServerUser[] {
    return [...this.users.values()]
  }
}

/** Helper: decrypt an account's cookie jar for use, bound to the owner (AAD). */
export function loadAccountCookies(box: SecretBox, discordUserId: string, acc: ServerRiotAccount): CookieJar | null {
  if (!acc.encCookies) return null
  try {
    return JSON.parse(box.decrypt(acc.encCookies, `${discordUserId}:${acc.key}`)) as CookieJar
  } catch {
    return null
  }
}

export function saveAccountCookies(box: SecretBox, discordUserId: string, acc: ServerRiotAccount, jar: CookieJar): void {
  acc.encCookies = box.encrypt(JSON.stringify(jar), `${discordUserId}:${acc.key}`)
}
