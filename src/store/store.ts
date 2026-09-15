import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ENTITY_KINDS, type EntityKind, type EntityMap, type ZmDeletion, type ZmDiff } from '../api/types.js'

export interface ApplyStats { upserted: Partial<Record<EntityKind, number>>; deleted: number }
export interface Meta { serverTimestamp: number; lastSyncAt: string | null }

export class Store {
  private constructor(private db: DatabaseSync) { this.migrate() }
  static open(file: string): Store { mkdirSync(dirname(file), { recursive: true }); return new Store(new DatabaseSync(file)) }
  static memory(): Store { return new Store(new DatabaseSync(':memory:')) }

  private migrate() {
    for (const k of ENTITY_KINDS) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS "${k}" (id TEXT PRIMARY KEY, raw TEXT NOT NULL${k === 'transaction' ? ', date TEXT' : ''})`)
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS tx_date ON "transaction"(date)`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)
  }

  applyDiff(diff: ZmDiff, syncedAt: Date, opts?: { reset?: boolean }): ApplyStats {
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
  }

  reset(): void {
    this.db.exec('BEGIN')
    try {
      for (const k of ENTITY_KINDS) this.db.exec(`DELETE FROM "${k}"`)
      this.db.exec('DELETE FROM meta')
      this.db.exec('COMMIT')
    } catch (e) { try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ } throw e }
  }

  getMeta(): Meta {
    const stmt = this.db.prepare(`SELECT value FROM meta WHERE key = ?`)
    const row = stmt.get('serverTimestamp') as { value: string } | undefined
    const lastSyncAt = stmt.get('lastSyncAt') as { value: string } | undefined
    return { serverTimestamp: row ? Number(row.value) : 0, lastSyncAt: lastSyncAt ? lastSyncAt.value : null }
  }

  all<K extends EntityKind>(kind: K): EntityMap[K][] {
    const rows = this.db.prepare(`SELECT raw FROM "${kind}" ORDER BY id`).all() as { raw: string }[]
    return rows.map(r => JSON.parse(r.raw))
  }

  hasData(): boolean {
    const row = this.db.prepare(`SELECT 1 FROM "user" LIMIT 1`).get()
    return row !== undefined
  }

  close(): void { this.db.close() }

  private setMeta(key: string, value: string) {
    this.db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)`).run(key, value)
  }
}
