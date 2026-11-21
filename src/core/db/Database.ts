import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic, type SqlValue } from 'sql.js'
import { MIGRATIONS } from './schema'

let sqlPromise: Promise<SqlJsStatic> | null = null

function loadSql(wasmPath?: string): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    const req = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)
    const p = wasmPath ?? req.resolve('sql.js/dist/sql-wasm.wasm')
    const wasmBinary = fs.readFileSync(p)
    sqlPromise = initSqlJs({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) as ArrayBuffer } as Parameters<typeof initSqlJs>[0])
  }
  return sqlPromise
}

export type Row = Record<string, SqlValue>
export type Params = SqlValue[] | Record<string, SqlValue>

/**
 * SQLite database backed by sql.js (WebAssembly).
 * Chosen over native bindings (better-sqlite3) so the Windows installer can be
 * built on any OS without native rebuilds. Data is persisted to a file
 * atomically (write temp → rename) after each write batch.
 */
export class AppDatabase {
  private dirty = false
  private flushTimer: NodeJS.Timeout | null = null
  private inTx = 0

  private constructor(
    private readonly db: SqlJsDatabase,
    private readonly filePath: string | null,
    private readonly flushDelayMs: number
  ) {}

  static async open(filePath: string | null, opts: { wasmPath?: string; flushDelayMs?: number } = {}): Promise<AppDatabase> {
    const SQL = await loadSql(opts.wasmPath)
    let db: SqlJsDatabase
    if (filePath && fs.existsSync(filePath)) {
      db = new SQL.Database(fs.readFileSync(filePath))
    } else {
      db = new SQL.Database()
    }
    const inst = new AppDatabase(db, filePath, opts.flushDelayMs ?? 150)
    inst.exec('PRAGMA foreign_keys = ON')
    inst.migrate()
    inst.flush()
    return inst
  }

  private migrate(): void {
    this.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
    const cur = Number(this.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'")?.value ?? 0)
    for (let v = cur; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v])
        this.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", [String(v + 1)])
      })
    }
  }

  get schemaVersion(): number {
    return Number(this.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'")?.value ?? 0)
  }

  exec(sql: string): void {
    this.db.exec(sql)
    this.markDirty()
  }

  run(sql: string, params: Params = []): { changes: number; lastId: number } {
    this.db.run(sql, params as never)
    const changes = this.db.getRowsModified()
    const lastId = Number(this.db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0]?.[0] ?? 0)
    if (changes > 0) this.markDirty()
    return { changes, lastId }
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params as never)
      const rows: T[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
      return rows
    } finally {
      stmt.free()
    }
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  transaction<T>(fn: () => T): T {
    if (this.inTx > 0) {
      this.inTx++
      try {
        return fn()
      } finally {
        this.inTx--
      }
    }
    this.db.exec('BEGIN')
    this.inTx++
    try {
      const r = fn()
      this.db.exec('COMMIT')
      this.markDirty()
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    } finally {
      this.inTx--
    }
  }

  private markDirty(): void {
    this.dirty = true
    if (!this.filePath || this.inTx > 0) return
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, this.flushDelayMs)
  }

  /** Writes the database to disk immediately (atomic replace). */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.filePath || !this.dirty) return
    const data = this.db.export()
    // sql.js export() resets pragmas; re-enable
    this.db.exec('PRAGMA foreign_keys = ON')
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, this.filePath)
    this.dirty = false
  }

  close(): void {
    this.flush()
    this.db.close()
  }
}
