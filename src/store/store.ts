import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { ENTITY_KINDS, type EntityKind, type EntityMap, type ZmDeletion, type ZmDiff } from '../api/types.js'
import { ZmError } from '../errors.js'
import { ensureDirMode, chmodIfExists } from '../fsutil.js'

export interface ApplyStats { upserted: Partial<Record<EntityKind, number>>; deleted: number }
export interface Meta { serverTimestamp: number; lastSyncAt: string | null }
export interface OpenOptions { busyTimeoutMs?: number; platform?: NodeJS.Platform }

const DEFAULT_BUSY_TIMEOUT_MS = 5000

// Primary sqlite result codes (the low byte of node:sqlite's `errcode`; an
// "extended" result code like SQLITE_BUSY_RECOVERY carries extra bits above
// that byte and must still be treated as a plain SQLITE_BUSY here).
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6
const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26

function primaryErrCode(e: unknown): number | undefined {
  const code = (e as { errcode?: unknown } | null)?.errcode
  return typeof code === 'number' ? (code & 0xff) : undefined
}

function busyError(): ZmError {
  return new ZmError('CACHE_BUSY', 'cache is busy (another zm sync is running)', 'retry in a few seconds')
}

function corruptCacheError(file: string | null): ZmError {
  return new ZmError('NO_CACHE', 'local cache is unreadable', `delete ${file ?? ':memory:'} and run zm sync --full`)
}

// Every sqlite-touching Store method funnels its errors through this: busy/
// locked -> CACHE_BUSY (exit 6, transient — caller should retry), corrupt or
// not-a-database -> NO_CACHE (exit 5, "unreadable" — delete and resync).
// Anything else (SQLITE_READONLY, SQLITE_CANTOPEN, SQLITE_FULL, SQLITE_IOERR,
// ...) is a real, distinct failure and is surfaced as UNEXPECTED with the
// underlying sqlite message, rather than being misreported as either of the
// above — in particular, `sync --full`'s delete-and-recreate recovery
// (cli/commands/sync.ts) must never run for these, since the file itself may
// be perfectly fine (e.g. a read-only filesystem, or a full disk).
function translateSqliteError(e: unknown, file: string | null): unknown {
  const code = primaryErrCode(e)
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED) return busyError()
  if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return corruptCacheError(file)
  if (code !== undefined) return new ZmError('UNEXPECTED', `sqlite error: ${(e as Error).message}`)
  return e
}

export class Store {
  private constructor(private db: DatabaseSync, private file: string | null = null) {}

  // Runs `fn`, translating any thrown sqlite error via translateSqliteError
  // above. Wraps every method that touches the database, not just open() —
  // a lock conflict or corruption can just as easily surface on a write
  // (applyDiff/reset) or a read (all/getMeta) as it can on open.
  private guard<T>(fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      throw translateSqliteError(e, this.file)
    }
  }

  static open(file: string, opts?: OpenOptions): Store {
    const platform = opts?.platform ?? process.platform
    ensureDirMode(dirname(file), 0o700, platform)

    let db: DatabaseSync
    try {
      db = new DatabaseSync(file)
    } catch (e) {
      throw translateSqliteError(e, file)
    }

    try {
      // busy_timeout first (a no-lock, connection-local setting) so the
      // injected wait actually applies to the journal_mode switch below,
      // which is the first statement that can contend for the file lock.
      db.exec(`PRAGMA busy_timeout=${opts?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`)
      db.exec('PRAGMA journal_mode=WAL')
    } catch (e) {
      db.close()
      throw translateSqliteError(e, file)
    }

    const store = new Store(db, file)
    try {
      store.migrate()
    } catch (e) {
      db.close()
      throw translateSqliteError(e, file)
    }

    chmodIfExists(file, 0o600, platform)
    chmodIfExists(`${file}-wal`, 0o600, platform)
    chmodIfExists(`${file}-shm`, 0o600, platform)
    return store
  }

  static memory(): Store {
    const store = new Store(new DatabaseSync(':memory:'))
    store.migrate()
    return store
  }

  private migrate() {
    for (const k of ENTITY_KINDS) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS "${k}" (id TEXT PRIMARY KEY, raw TEXT NOT NULL${k === 'transaction' ? ', date TEXT' : ''})`)
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS tx_date ON "transaction"(date)`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)
  }

  applyDiff(diff: ZmDiff, syncedAt: Date, opts?: { reset?: boolean }): ApplyStats {
    return this.guard(() => {
      const stats: ApplyStats = { upserted: {}, deleted: 0 }
      this.db.exec('BEGIN')
      try {
        if (opts?.reset) {
          for (const k of ENTITY_KINDS) this.db.exec(`DELETE FROM "${k}"`)
          this.db.exec('DELETE FROM meta')
        }
        for (const k of ENTITY_KINDS) {
          const items = diff[k] as Array<{ id: string | number; date?: string }> | undefined
          if (!items?.length) continue
          const stmt = k === 'transaction'
            ? this.db.prepare(`INSERT OR REPLACE INTO "transaction"(id, raw, date) VALUES (?, ?, ?)`)
            : this.db.prepare(`INSERT OR REPLACE INTO "${k}"(id, raw) VALUES (?, ?)`)
          const ids = new Set<string>()
          for (const it of items) {
            const id = String(it.id)
            ids.add(id)
            if (k === 'transaction') stmt.run(id, JSON.stringify(it), it.date ?? null)
            else stmt.run(id, JSON.stringify(it))
          }
          // Distinct ids upserted, not the raw item count: the same id can appear
          // more than once within one diff (each write just replaces the last).
          stats.upserted[k] = ids.size
        }
        const deletionsByKind = new Map<string, ZmDeletion[]>()
        for (const d of diff.deletion ?? []) {
          if (!(ENTITY_KINDS as string[]).includes(d.object)) continue
          const arr = deletionsByKind.get(d.object) ?? []
          arr.push(d)
          deletionsByKind.set(d.object, arr)
        }
        for (const [kind, dels] of deletionsByKind) {
          const stmt = this.db.prepare(`DELETE FROM "${kind}" WHERE id = ?`)
          for (const d of dels) {
            const r = stmt.run(String(d.id))
            stats.deleted += Number(r.changes)
          }
        }
        this.setMeta('serverTimestamp', String(diff.serverTimestamp))
        this.setMeta('lastSyncAt', syncedAt.toISOString())
        this.db.exec('COMMIT')
      } catch (e) { try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ } throw e }
      return stats
    })
  }

  reset(): void {
    this.guard(() => {
      this.db.exec('BEGIN')
      try {
        for (const k of ENTITY_KINDS) this.db.exec(`DELETE FROM "${k}"`)
        this.db.exec('DELETE FROM meta')
        this.db.exec('COMMIT')
      } catch (e) { try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ } throw e }
    })
  }

  getMeta(): Meta {
    return this.guard(() => {
      const stmt = this.db.prepare(`SELECT value FROM meta WHERE key = ?`)
      const row = stmt.get('serverTimestamp') as { value: string } | undefined
      const lastSyncAt = stmt.get('lastSyncAt') as { value: string } | undefined
      return { serverTimestamp: row ? Number(row.value) : 0, lastSyncAt: lastSyncAt ? lastSyncAt.value : null }
    })
  }

  all<K extends EntityKind>(kind: K): EntityMap[K][] {
    return this.guard(() => {
      const rows = this.db.prepare(`SELECT raw FROM "${kind}" ORDER BY id`).all() as { raw: string }[]
      try {
        return rows.map(r => JSON.parse(r.raw))
      } catch {
        // A row whose `raw` column isn't valid JSON means the cache itself is
        // corrupted (this table is never written with anything but
        // JSON.stringify'd data) — same recovery as a corrupted db file.
        throw corruptCacheError(this.file)
      }
    })
  }

  hasData(): boolean {
    return this.guard(() => {
      const row = this.db.prepare(`SELECT 1 FROM "user" LIMIT 1`).get()
      return row !== undefined
    })
  }

  close(): void { this.db.close() }

  private setMeta(key: string, value: string) {
    this.db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)`).run(key, value)
  }
}
