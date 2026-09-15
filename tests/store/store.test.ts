import { it, expect } from 'vitest'
import { mkdtempSync, existsSync, statSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store/store.js'
import { fixtureDiff } from '../fixtures/diff.js'

it('applies a full diff', () => {
  const s = Store.memory()
  const stats = s.applyDiff(fixtureDiff(), new Date('2026-09-15T08:00:00Z'))
  expect(stats.upserted.transaction).toBe(23)
  expect(s.all('account')).toHaveLength(5)
  expect(s.all('transaction').find(t => t.id === 't1')?.outcome).toBe(3000)
  expect(s.getMeta()).toEqual({ serverTimestamp: 1789000000, lastSyncAt: '2026-09-15T08:00:00.000Z' })
  expect(s.hasData()).toBe(true)
})

it('upserts changed entities and applies deletions', () => {
  const s = Store.memory()
  s.applyDiff(fixtureDiff(), new Date('2026-09-15T08:00:00Z'))
  const t1 = s.all('transaction').find(t => t.id === 't1')!
  const stats = s.applyDiff({
    serverTimestamp: 1789000500,
    transaction: [{ ...t1, outcome: 3500 }],
    deletion: [{ id: 't2', object: 'transaction', stamp: 1789000400, user: 10 }, { id: 'x', object: 'reminder', stamp: 1, user: 10 }],
  }, new Date('2026-09-16T08:00:00Z'))
  expect(stats).toEqual({ upserted: { transaction: 1 }, deleted: 1 })
  expect(s.all('transaction').find(t => t.id === 't1')?.outcome).toBe(3500)
  expect(s.all('transaction').some(t => t.id === 't2')).toBe(false)
  expect(s.getMeta().serverTimestamp).toBe(1789000500)
})

it('keeps unknown fields in raw json', () => {
  const s = Store.memory()
  const d = fixtureDiff()
  ;(d.account![0] as any).newField = 42
  s.applyDiff(d, new Date())
  expect((s.all('account').find(a => a.id === 'acc-pln') as any).newField).toBe(42)
})

it('returns entities in deterministic id order, stable across upserts', () => {
  const s = Store.memory()
  s.applyDiff(fixtureDiff(), new Date('2026-09-15T08:00:00Z'))
  expect(s.all('account').map(a => a.id)).toEqual(['acc-debt', 'acc-eur', 'acc-old', 'acc-partner', 'acc-pln'])
  const pln = s.all('account').find(a => a.id === 'acc-pln')!
  s.applyDiff({ serverTimestamp: 1789000600, account: [{ ...pln, balance: 12345 }] }, new Date('2026-09-16T08:00:00Z'))
  expect(s.all('account').map(a => a.id)).toEqual(['acc-debt', 'acc-eur', 'acc-old', 'acc-partner', 'acc-pln'])
})

it('applyDiff throws and leaves the store unchanged when an entity cannot be serialized', () => {
  const s = Store.memory()
  const d = fixtureDiff()
  ;(d.account![0] as any).bad = 1n // BigInt is not JSON-serializable
  expect(() => s.applyDiff(d, new Date())).toThrow()
  expect(s.hasData()).toBe(false)
  expect(s.getMeta()).toEqual({ serverTimestamp: 0, lastSyncAt: null })
})

it('applyDiff with reset:true removes rows absent from the new diff, in one transaction', () => {
  const s = Store.memory()
  s.applyDiff(fixtureDiff(), new Date('2026-09-15T08:00:00Z'))
  expect(s.all('transaction').length).toBe(23)
  const stats = s.applyDiff(
    { serverTimestamp: 999, user: [{ id: 10, login: 'owner', currency: 3, parent: null, changed: 1 }] },
    new Date('2026-09-16T00:00:00Z'),
    { reset: true },
  )
  expect(stats.upserted).toEqual({ user: 1 })
  expect(s.all('transaction')).toEqual([])
  expect(s.all('account')).toEqual([])
  expect(s.all('user')).toEqual([{ id: 10, login: 'owner', currency: 3, parent: null, changed: 1 }])
  expect(s.getMeta()).toEqual({ serverTimestamp: 999, lastSyncAt: '2026-09-16T00:00:00.000Z' })
})

it('upserted count reflects distinct ids, even when the same id appears twice in one diff', () => {
  const s = Store.memory()
  const stats = s.applyDiff({
    serverTimestamp: 1,
    account: [
      { id: 'a1', user: 10, instrument: 1, type: 'cash', title: 'A', balance: 0, inBalance: true, archive: false, changed: 1 },
      { id: 'a1', user: 10, instrument: 1, type: 'cash', title: 'A updated', balance: 5, inBalance: true, archive: false, changed: 2 },
    ],
  }, new Date())
  expect(stats.upserted).toEqual({ account: 1 })
  expect(s.all('account')).toHaveLength(1)
  expect(s.all('account')[0]!.title).toBe('A updated')
})

it('reset clears data and meta', () => {
  const s = Store.memory()
  s.applyDiff(fixtureDiff(), new Date())
  s.reset()
  expect(s.hasData()).toBe(false)
  expect(s.getMeta()).toEqual({ serverTimestamp: 0, lastSyncAt: null })
})

it('open creates the file and parent dirs', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'zm-')), 'nested', 'zm.sqlite')
  const s = Store.open(file)
  s.close()
  expect(existsSync(file)).toBe(true)
})

it('persists data across close and reopen of the same file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'zm-')), 'zm.sqlite')
  const s1 = Store.open(file)
  s1.applyDiff(fixtureDiff(), new Date('2026-09-15T08:00:00Z'))
  s1.close()

  const s2 = Store.open(file)
  expect(s2.all('account')).toHaveLength(5)
  expect(s2.all('transaction').find(t => t.id === 't1')?.outcome).toBe(3000)
  expect(s2.getMeta()).toEqual({ serverTimestamp: 1789000000, lastSyncAt: '2026-09-15T08:00:00.000Z' })
  s2.close()
})

// A-1: file permissions.
it('creates the cache dir with mode 700 and the db file with mode 600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-'))
  const file = join(dir, 'nested', 'zm.sqlite')
  const s = Store.open(file)
  expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  s.close()
})
// Review round item 3: the previous version of this test relied on whatever
// mode sqlite happens to create the -wal file at, which — depending on
// umask — could already be 0600 with no chmod involved at all, proving
// nothing. Explicitly widening the sidecar files to 0644 first means the
// test can only pass if Store.open actually narrows them back down.
it('chmods -wal/-shm sidecar files to 600 even when they already exist at a more permissive mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-'))
  const file = join(dir, 'zm.sqlite')
  const s = Store.open(file)
  s.applyDiff(fixtureDiff(), new Date()) // a write forces WAL to actually create -wal/-shm
  expect(existsSync(`${file}-wal`)).toBe(true)
  expect(existsSync(`${file}-shm`)).toBe(true)
  chmodSync(`${file}-wal`, 0o644)
  chmodSync(`${file}-shm`, 0o644)

  // `s` is deliberately kept open here: closing it would checkpoint and
  // remove the -wal/-shm files outright, rather than leaving them in place
  // (at 0644) for the second open to actually narrow back down.
  const s2 = Store.open(file)
  expect(statSync(`${file}-wal`).mode & 0o777).toBe(0o600)
  expect(statSync(`${file}-shm`).mode & 0o777).toBe(0o600)
  s2.close()
  s.close()
})
it('skips chmod on win32 without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-'))
  const file = join(dir, 'zm.sqlite')
  const s = Store.open(file, { platform: 'win32' })
  expect(existsSync(file)).toBe(true)
  s.close()
})

// A-2: locking.
it('opens with WAL journal mode and an injectable busy_timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-'))
  const file = join(dir, 'zm.sqlite')
  const s = Store.open(file, { busyTimeoutMs: 1234 })
  const raw = new DatabaseSync(file)
  expect((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
  raw.close()
  s.close()
})
it('reports CACHE_BUSY (exit 6) when the db is locked by another connection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-'))
  const file = join(dir, 'zm.sqlite')
  // A file that exists but has never been switched to WAL mode yet: BEGIN
  // EXCLUSIVE on it takes a real exclusive lock immediately, which is what a
  // concurrent `zm sync` (or another process) holding the file could look like.
  new DatabaseSync(file).exec('CREATE TABLE IF NOT EXISTS t (id TEXT)')
  const blocker = new DatabaseSync(file)
  blocker.exec('BEGIN EXCLUSIVE')
  try {
    expect(() => Store.open(file, { busyTimeoutMs: 50 })).toThrow(expect.objectContaining({ code: 'CACHE_BUSY' }))
  } finally {
    blocker.exec('ROLLBACK')
    blocker.close()
  }
})

// Review round item 1(a): CACHE_BUSY must also fire on a write (applyDiff),
// not only on open — the real-world conflict (two `zm sync` processes) is a
// writer-vs-writer lock, not a reader ever being blocked in WAL mode.
it('applyDiff reports CACHE_BUSY when another connection holds an uncommitted write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-'))
  const file = join(dir, 'zm.sqlite')
  const s = Store.open(file, { busyTimeoutMs: 100 })

  // A second raw connection simulating a concurrent `zm sync`: BEGIN
  // IMMEDIATE + an actual write, left uncommitted, is a real writer lock in
  // WAL mode (unlike a bare BEGIN EXCLUSIVE with no write, which — per A-2's
  // own busy test — only blocks the initial WAL-mode switch, not a later
  // write once WAL is already established).
  const blocker = new DatabaseSync(file)
  blocker.exec('PRAGMA journal_mode=WAL')
  blocker.exec('BEGIN IMMEDIATE')
  blocker.exec(`INSERT OR REPLACE INTO "user"(id, raw) VALUES ('999', '{}')`)
  try {
    expect(() => s.applyDiff(fixtureDiff(), new Date())).toThrow(expect.objectContaining({ code: 'CACHE_BUSY' }))
  } finally {
    blocker.exec('ROLLBACK')
    blocker.close()
    s.close()
  }
})

// A-4: corrupted cache.
it('throws NO_CACHE with a delete-and-resync hint when the db file is garbage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-'))
  const file = join(dir, 'zm.sqlite')
  writeFileSync(file, 'not a sqlite file at all')
  expect(() => Store.open(file)).toThrow(
    expect.objectContaining({ code: 'NO_CACHE', hint: `delete ${file} and run zm sync --full` }),
  )
})
it('throws NO_CACHE when a stored row is not valid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-'))
  const file = join(dir, 'zm.sqlite')
  const s = Store.open(file)
  s.applyDiff(fixtureDiff(), new Date())
  s.close()
  // Corrupt one row's raw column directly, bypassing applyDiff's JSON.stringify.
  const raw = new DatabaseSync(file)
  raw.exec('PRAGMA journal_mode=WAL')
  raw.prepare(`UPDATE "user" SET raw = 'not json' WHERE id = '10'`).run()
  raw.close()
  const s2 = Store.open(file)
  expect(() => s2.all('user')).toThrow(expect.objectContaining({ code: 'NO_CACHE' }))
  s2.close()
})
it('throws NO_CACHE for a malformed (but not merely not-a-database) sqlite file, via SQLITE_CORRUPT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-'))
  const file = join(dir, 'zm.sqlite')
  {
    const s = Store.open(file)
    s.applyDiff(fixtureDiff(), new Date())
    s.close()
  }
  // Scramble bytes inside the first btree page (past the 100-byte header, so
  // the sqlite magic string survives and this is recognised as a database,
  // just an internally malformed one) — reproduces a genuine SQLITE_CORRUPT
  // (11), distinct from SQLITE_NOTADB (26, garbage-from-the-start above).
  const buf = readFileSync(file)
  for (let i = 100; i < Math.min(buf.length, 300); i++) buf[i] = (i * 37) % 256
  writeFileSync(file, buf)
  expect(() => Store.open(file)).toThrow(expect.objectContaining({ code: 'NO_CACHE' }))
})
// Review round item 6: only SQLITE_CORRUPT/SQLITE_NOTADB (and a JSON parse
// failure) count as "unreadable" (NO_CACHE) — a distinct sqlite failure like
// SQLITE_READONLY or SQLITE_CANTOPEN must surface as its own UNEXPECTED
// error instead, so `sync --full` never mistakes it for corruption and
// deletes a perfectly good file.
it('a read-only db file surfaces as UNEXPECTED, not NO_CACHE, and is not corruption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-'))
  const file = join(dir, 'zm.sqlite')
  {
    const s = Store.open(file)
    s.applyDiff(fixtureDiff(), new Date())
    s.close()
  }
  chmodSync(file, 0o400)
  try {
    // Opening itself may succeed (reads are fine); the write in applyDiff is
    // what actually hits SQLITE_READONLY.
    const s = Store.open(file)
    try {
      expect(() => s.applyDiff(fixtureDiff(), new Date())).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }))
    } finally {
      s.close()
    }
  } finally {
    chmodSync(file, 0o600)
  }
})
it('a directory in place of the db file surfaces as UNEXPECTED (SQLITE_CANTOPEN), not NO_CACHE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-'))
  const file = join(dir, 'zm.sqlite')
  mkdirSync(file)
  expect(() => Store.open(file)).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }))
})
