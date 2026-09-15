import { it, expect } from 'vitest'
import { writeFileSync, readFileSync, mkdirSync, statSync, existsSync, chmodSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { run } from '../../src/cli/program.js'
import { testContext, seededContext } from '../helpers.js'
import { saveToken } from '../../src/auth/token.js'

// A-20: `zm status` — no network, works without a token and without a cache,
// never prints the token.
it('works with no token and no cache at all', async () => {
  const t = testContext()
  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  const data = t.json().data
  expect(data.cache).toEqual({ path: t.ctx.paths.cacheDb, exists: false, readable: false, lastSyncAt: null, ageHours: null })
  expect(data.token).toEqual({ source: null })
  expect(data.configDir).toBe(t.ctx.paths.configDir)
  expect(data.budgetDir).toBe(t.ctx.paths.budgetDir)
  expect(data.version).toMatch(/^\d+\.\d+\.\d+$/)
})
it('never calls the network', async () => {
  const t = testContext({
    env: { ZENMONEY_TOKEN: 'tok' },
    fetch: (async () => { throw new Error('status must never call fetch') }) as any,
  })
  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
})
it('reports the cache lastSyncAt/ageHours when a cache exists', async () => {
  const t = seededContext({ now: () => new Date('2026-09-16T08:00:00Z') }) // 1 day after sync
  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  const cache = t.json().data.cache
  expect(cache.exists).toBe(true)
  expect(cache.readable).toBe(true)
  expect(cache.lastSyncAt).toBe('2026-09-15T08:00:00.000Z')
  expect(cache.ageHours).toBe(24)
})
it('reports token.source without ever printing the token itself', async () => {
  const t = testContext({ env: { ZENMONEY_TOKEN: 'super-secret-token' } })
  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  expect(t.json().data.token).toEqual({ source: 'env' })
  expect(t.out.join('')).not.toContain('super-secret-token')
})
it('reports token.source: "config" for a token saved to config.json', async () => {
  const t = testContext()
  saveToken('config-secret', { env: {}, keychain: null, configFile: t.ctx.paths.configFile })
  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  expect(t.json().data.token).toEqual({ source: 'config' })
  expect(t.out.join('')).not.toContain('config-secret')
})
it('reports cache.readable: false and cache.error for a corrupted cache, without failing', async () => {
  const t = testContext()
  mkdirSync(dirname(t.ctx.paths.cacheDb), { recursive: true })
  writeFileSync(t.ctx.paths.cacheDb, 'not a sqlite file')
  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  const cache = t.json().data.cache
  expect(cache.exists).toBe(true)
  expect(cache.readable).toBe(false)
  expect(cache.lastSyncAt).toBeNull()
  expect(typeof cache.error).toBe('string')
  expect(cache.error.length).toBeGreaterThan(0)
})
it('reports cache.readable: false via the readOnly-open fallback when a stray non-empty -wal forces it', async () => {
  // A corrupted main db file combined with a real, non-empty -wal file:
  // walExists() is true, so readCacheInfo skips the immutable approach
  // entirely and goes straight to readViaNormalReadOnly — exercising that
  // path's own failure branch specifically, not the immutable one.
  const t = testContext()
  mkdirSync(dirname(t.ctx.paths.cacheDb), { recursive: true })
  writeFileSync(t.ctx.paths.cacheDb, 'not a sqlite file')
  writeFileSync(`${t.ctx.paths.cacheDb}-wal`, 'not empty')
  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  const cache = t.json().data.cache
  expect(cache.readable).toBe(false)
  expect(typeof cache.error).toBe('string')
})
// Review round item 8: `zm status` must be a pure read — no mkdir, no WAL
// pragma, no migrate, no chmod. Verified two ways: (a) a garbage cache file's
// bytes are byte-for-byte unchanged after `zm status` runs against it
// (Store.open would have left it a valid empty sqlite db instead, since it
// creates/migrates on open); (b) running status with no cache at all must
// not create the cache file, its parent dir, or the config dir.
it('does not modify a garbage cache file at all (opens read-only)', async () => {
  const t = testContext()
  mkdirSync(dirname(t.ctx.paths.cacheDb), { recursive: true })
  writeFileSync(t.ctx.paths.cacheDb, 'not a sqlite file')
  const before = readFileSync(t.ctx.paths.cacheDb)

  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)

  expect(readFileSync(t.ctx.paths.cacheDb)).toEqual(before)
})
it('does not create the cache file, cache dir, or config dir when none exist', async () => {
  const t = testContext()
  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  expect(existsSync(t.ctx.paths.cacheDb)).toBe(false)
  expect(existsSync(t.ctx.paths.cacheDir)).toBe(false)
  expect(existsSync(t.ctx.paths.configDir)).toBe(false)
})
it('does not chmod the cache file (leaves an unusual mode exactly as it was)', async () => {
  const t = seededContext()
  chmodSync(t.ctx.paths.cacheDb, 0o644) // deliberately not the 0600 Store.open would set
  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  expect(statSync(t.ctx.paths.cacheDb).mode & 0o777).toBe(0o644)
})
// Follow-up round item 1: the read-only open used to still create -wal/-shm
// sidecar files next to a normal, already-checkpointed cache — reading a
// database in WAL mode (even read-only) otherwise needs to create the
// shared-memory index. Confirmed empirically before fixing (see the
// "Follow-up round" section of audit-fix-report.md).
//
// This covers only the immutable-URI path (approach (a) in status.ts,
// taken here because a cleanly-closed cache has no `-wal` yet): that path
// never creates any file at all, by design. It intentionally does NOT
// cover the plain read-only fallback (approach (b)) — that path can
// legitimately need to create `-shm`/`-wal` just to open a WAL-mode
// database at all, and, since the sidecar-deletion fix, no longer deletes
// them afterwards (deleting a sidecar another process may start relying on
// the instant this connection closes risked corrupting that process's view
// of the database) — see README.md/docs/architecture.md for where this is
// documented as an accepted rare fallback-path outcome.
it('leaves no -wal/-shm sidecar files behind after status on a normal, closed cache (immutable path)', async () => {
  const t = seededContext()
  expect(existsSync(`${t.ctx.paths.cacheDb}-wal`)).toBe(false) // sanity: none before status runs
  expect(existsSync(`${t.ctx.paths.cacheDb}-shm`)).toBe(false)
  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  expect(existsSync(`${t.ctx.paths.cacheDb}-wal`)).toBe(false)
  expect(existsSync(`${t.ctx.paths.cacheDb}-shm`)).toBe(false)
})
// The fallback path (approach (b)) is exercised by the "stray non-empty
// -wal" test above and the "read-only cache directory" test below — neither
// asserts anything about sidecar files being absent afterwards, since this
// path may legitimately leave them behind (see the comment on the test
// above, and status.ts's readViaNormalReadOnly).
// Follow-up round item 1: a normal read-only open in a directory that isn't
// writable failed outright (SQLITE_READONLY_CANTINIT) even for a perfectly
// healthy cache, because it couldn't create the `-shm` index it needs. The
// immutable-URI approach sidesteps this — it never needs `-shm` at all.
it('reports a healthy cache as readable in a read-only cache directory', async () => {
  const t = seededContext({ now: () => new Date('2026-09-16T08:00:00Z') })
  const dir = dirname(t.ctx.paths.cacheDb)
  chmodSync(dir, 0o555)
  try {
    expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
    const cache = t.json().data.cache
    expect(cache.readable).toBe(true)
    expect(cache.lastSyncAt).toBe('2026-09-15T08:00:00.000Z')
    expect(cache.ageHours).toBe(24)
  } finally {
    chmodSync(dir, 0o700) // restore so temp-dir cleanup can still remove it
  }
})
// Follow-up round item 1: a transient lock (a concurrent `zm sync` mid-write)
// must not make a perfectly healthy cache report as unreadable — status
// should wait it out (via busy_timeout) rather than fail on the first try.
// A real second process holds an uncommitted write for a short, bounded
// time; a sentinel file signals once the lock is actually held, so `zm
// status` is only invoked once there's something real to wait out.
it('waits out a transient lock via busy_timeout instead of reporting unreadable', async () => {
  const t = seededContext()
  const lockAcquiredFile = `${t.ctx.paths.cacheDb}.lock-acquired`
  const holdMs = 300
  const child = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('fs');
    const db = new DatabaseSync(${JSON.stringify(t.ctx.paths.cacheDb)});
    db.exec('PRAGMA journal_mode=WAL');
    // locking_mode=EXCLUSIVE (rather than a plain BEGIN IMMEDIATE) is what
    // actually makes a reader contend in WAL mode — a plain in-progress
    // write never blocks a reader, which only ever sees the last committed
    // snapshot regardless of a concurrent writer (confirmed empirically; see
    // the "Follow-up round" section of audit-fix-report.md).
    db.exec('PRAGMA locking_mode=EXCLUSIVE');
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT OR REPLACE INTO meta(key, value) VALUES ('probe', 'x')");
    fs.writeFileSync(${JSON.stringify(lockAcquiredFile)}, 'locked');
    const until = Date.now() + ${holdMs};
    while (Date.now() < until) { /* hold the exclusive lock open */ }
    db.exec('COMMIT');
    db.close(); // releases the exclusive lock
  `])
  let childStderr = ''
  child.stderr?.on('data', chunk => { childStderr += chunk })

  try {
    // Synchronous poll (Atomics.wait as a portable sleep) for the child to
    // actually acquire the lock before racing it with our own status call.
    // Bounded by a deadline, and bails out early if the child has already
    // exited: without either check, a child that crashes before ever
    // writing the sentinel file would spin here forever (Atomics.wait's own
    // timeout just controls the poll interval, not an overall deadline),
    // hanging the whole vitest worker instead of failing this one test.
    const sync = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 5000
    while (!existsSync(lockAcquiredFile)) {
      if (child.exitCode !== null) {
        throw new Error(`lock-holder child exited early (code ${child.exitCode}) before acquiring the lock; stderr: ${childStderr}`)
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lock-holder child to acquire the lock; stderr: ${childStderr}`)
      }
      Atomics.wait(sync, 0, 0, 5)
    }

    const code = await run(['node', 'zm', 'status'], t.ctx)

    expect(code).toBe(0)
    const cache = t.json().data.cache
    // No wall-clock timing assertion (flaky under CI/system load): the
    // behavioural proof that `zm status` actually waited out the lock,
    // rather than failing fast, is that it comes back readable with the
    // correct data at all — a `busy_timeout` of only STATUS_BUSY_TIMEOUT_MS
    // (see status.ts) that gave up immediately would instead report
    // `readable: false` while the child still holds its exclusive lock.
    expect(cache.readable).toBe(true)
    expect(cache.lastSyncAt).toBe('2026-09-15T08:00:00.000Z')
  } finally {
    await new Promise(resolve => child.on('exit', resolve))
  }
}, 10_000)
