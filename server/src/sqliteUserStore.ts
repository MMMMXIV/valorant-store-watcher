import { AppDatabase } from '../../src/core'
import type { ServerRiotAccount, ServerUser, UserStore } from './userStore'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  discord_user_id TEXT PRIMARY KEY,
  consented_at TEXT, consent_version TEXT, push_token TEXT,
  wishlist_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS riot_accounts (
  discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
  key TEXT NOT NULL, label TEXT NOT NULL, puuid TEXT, game_name TEXT, region TEXT,
  region_override TEXT NOT NULL DEFAULT 'auto', last_period_end TEXT, needs_relogin INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (discord_user_id, key)
);
-- Encrypted cookies live in a separate table so access can be narrowed.
CREATE TABLE IF NOT EXISTS riot_secrets (
  discord_user_id TEXT NOT NULL, key TEXT NOT NULL, enc_cookies TEXT,
  PRIMARY KEY (discord_user_id, key)
);
`

/** SQLite-backed UserStore (one file on the server disk). Cookies are already encrypted by SecretBox. */
export class SqliteUserStore implements UserStore {
  private constructor(private db: AppDatabase) {}

  static async open(filePath: string | null): Promise<SqliteUserStore> {
    const db = await AppDatabase.open(filePath)
    db.exec(SCHEMA)
    return new SqliteUserStore(db)
  }

  getUser(id: string): ServerUser | null {
    const row = this.db.get<{ discord_user_id: string; consented_at: string | null; consent_version: string | null; push_token: string | null; wishlist_json: string }>(
      'SELECT * FROM users WHERE discord_user_id = ?',
      [id]
    )
    if (!row) return null
    const accounts = this.db
      .all<{ key: string; label: string; puuid: string | null; game_name: string | null; region: string | null; region_override: string; last_period_end: string | null; needs_relogin: number }>(
        'SELECT * FROM riot_accounts WHERE discord_user_id = ? ORDER BY rowid',
        [id]
      )
      .map((a): ServerRiotAccount => ({
        key: a.key,
        label: a.label,
        puuid: a.puuid,
        gameName: a.game_name,
        region: a.region,
        regionOverride: a.region_override,
        lastPeriodEnd: a.last_period_end,
        needsRelogin: a.needs_relogin === 1,
        encCookies: this.db.get<{ enc_cookies: string | null }>('SELECT enc_cookies FROM riot_secrets WHERE discord_user_id = ? AND key = ?', [id, a.key])?.enc_cookies ?? null
      }))
    let wishlist: string[] = []
    try {
      wishlist = JSON.parse(row.wishlist_json) as string[]
    } catch {
      /* ignore */
    }
    return { discordUserId: id, consentedAt: row.consented_at, consentVersion: row.consent_version, pushToken: row.push_token, accounts, wishlistSkinIds: wishlist }
  }

  upsertUser(u: ServerUser): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO users(discord_user_id, consented_at, consent_version, push_token, wishlist_json) VALUES (?,?,?,?,?)
         ON CONFLICT(discord_user_id) DO UPDATE SET consented_at=excluded.consented_at, consent_version=excluded.consent_version, push_token=excluded.push_token, wishlist_json=excluded.wishlist_json`,
        [u.discordUserId, u.consentedAt, u.consentVersion, u.pushToken, JSON.stringify(u.wishlistSkinIds)]
      )
      const keep = new Set(u.accounts.map((a) => a.key))
      for (const existing of this.db.all<{ key: string }>('SELECT key FROM riot_accounts WHERE discord_user_id = ?', [u.discordUserId])) {
        if (!keep.has(existing.key)) {
          this.db.run('DELETE FROM riot_accounts WHERE discord_user_id = ? AND key = ?', [u.discordUserId, existing.key])
          this.db.run('DELETE FROM riot_secrets WHERE discord_user_id = ? AND key = ?', [u.discordUserId, existing.key])
        }
      }
      for (const a of u.accounts) {
        this.db.run(
          `INSERT INTO riot_accounts(discord_user_id, key, label, puuid, game_name, region, region_override, last_period_end, needs_relogin) VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(discord_user_id, key) DO UPDATE SET label=excluded.label, puuid=excluded.puuid, game_name=excluded.game_name, region=excluded.region, region_override=excluded.region_override, last_period_end=excluded.last_period_end, needs_relogin=excluded.needs_relogin`,
          [u.discordUserId, a.key, a.label, a.puuid, a.gameName, a.region, a.regionOverride, a.lastPeriodEnd, a.needsRelogin ? 1 : 0]
        )
        this.db.run('INSERT OR REPLACE INTO riot_secrets(discord_user_id, key, enc_cookies) VALUES (?,?,?)', [u.discordUserId, a.key, a.encCookies])
      }
    })
  }

  deleteUser(id: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM riot_secrets WHERE discord_user_id = ?', [id])
      this.db.run('DELETE FROM riot_accounts WHERE discord_user_id = ?', [id])
      this.db.run('DELETE FROM users WHERE discord_user_id = ?', [id])
    })
  }

  allUsers(): ServerUser[] {
    return this.db.all<{ discord_user_id: string }>('SELECT discord_user_id FROM users').map((r) => this.getUser(r.discord_user_id)!)
  }

  close(): void {
    this.db.close()
  }
}
