/** Ordered list of migrations. Never edit an existing entry; append new ones. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE weapons (
    id TEXT PRIMARY KEY, name_ja TEXT NOT NULL, name_en TEXT NOT NULL,
    category TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE tiers (
    id TEXT PRIMARY KEY, name_ja TEXT NOT NULL, name_en TEXT NOT NULL,
    dev_name TEXT NOT NULL, rank INTEGER NOT NULL, color TEXT NOT NULL
  );
  CREATE TABLE skins (
    id TEXT PRIMARY KEY, weapon_id TEXT NOT NULL, name_ja TEXT NOT NULL, name_en TEXT NOT NULL,
    tier_id TEXT, icon_url TEXT, render_url TEXT, removed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_skins_weapon ON skins(weapon_id);
  CREATE TABLE skin_aliases (
    alias_id TEXT PRIMARY KEY, skin_id TEXT NOT NULL, kind TEXT NOT NULL
  );
  CREATE INDEX idx_alias_skin ON skin_aliases(skin_id);

  CREATE TABLE wishlist (
    skin_id TEXT PRIMARY KEY, priority TEXT NOT NULL DEFAULT 'normal',
    position INTEGER NOT NULL, added_at TEXT NOT NULL
  );

  CREATE TABLE store_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, account_name TEXT,
    period_key TEXT NOT NULL, period_start TEXT, period_end TEXT, fetched_at TEXT NOT NULL,
    source TEXT NOT NULL, UNIQUE(account_id, period_key)
  );
  CREATE TABLE store_offers (
    snapshot_id INTEGER NOT NULL REFERENCES store_snapshots(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL, raw_item_id TEXT, skin_id TEXT, price INTEGER, currency_id TEXT,
    PRIMARY KEY (snapshot_id, slot)
  );
  CREATE INDEX idx_offers_skin ON store_offers(skin_id);

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, period_key TEXT NOT NULL,
    skin_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, sent_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
    UNIQUE(account_id, period_key, skin_id, kind)
  );

  CREATE TABLE check_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT,
    trigger TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, period_key TEXT,
    matched_count INTEGER NOT NULL DEFAULT 0, notified_count INTEGER NOT NULL DEFAULT 0, message TEXT
  );

  CREATE TABLE error_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL
  );
  `
]
