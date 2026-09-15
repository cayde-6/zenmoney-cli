import { it, expect } from 'vitest'
import { writeFileSync, readFileSync, mkdirSync, statSync, existsSync, chmodSync, readdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
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
  expect(data.ownersFile).toEqual({ path: join(t.ctx.paths.configDir, 'owners.yaml'), exists: false })
  expect(data.version).toMatch(/^\d+\.\d+\.\d+$/)
})
it('reports ownersFile.exists: true once owners.yaml has been created', async () => {
  const t = testContext()
  mkdirSync(t.ctx.paths.configDir, { recursive: true })
  writeFileSync(join(t.ctx.paths.configDir, 'owners.yaml'), 'owners:\n  alex:\n    accounts: [a]\n')
  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  expect(t.json().data.ownersFile).toEqual({ path: join(t.ctx.paths.configDir, 'owners.yaml'), exists: true })
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
// Review round item 1: a permission problem on the real cache file itself
// must be reported as a plain cache-side error, with none of the "could
// not snapshot the cache: " prefix reserved for a problem on the local
// temp side — confirmed with a real, unreadable file (chmod 0000) rather
// than a mocked one, since this is exactly the scenario an earlier version
// of status.ts got wrong (copyFileSync's `.dest` being set on every
// failure, source-side included, made it indistinguishable from a
// temp-side one). win32 has no POSIX permission bits, so chmod 0000
// doesn't actually block reads there — skipped on that platform, same as
// the other permission-based tests in this file.
it.skipIf(process.platform === 'win32')('reports a plain (unprefixed) error for a cache file with no read permission', async () => {
  const t = testContext()
  mkdirSync(dirname(t.ctx.paths.cacheDb), { recursive: true })
  writeFileSync(t.ctx.paths.cacheDb, 'irrelevant contents')
  chmodSync(t.ctx.paths.cacheDb, 0o000)
  try {
    expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
    const cache = t.json().data.cache
    expect(cache.exists).toBe(true)
    expect(cache.readable).toBe(false)
    expect(typeof cache.error).toBe('string')
    expect(cache.error).not.toMatch(/^could not snapshot the cache: /)
  } finally {
    chmodSync(t.ctx.paths.cacheDb, 0o600) // restore so cleanup can remove it
  }
})
// Same as above, but for a `-wal` file that exists and is itself
// unreadable (rather than the main db file) — the main db file stays
// perfectly readable throughout, isolating the check specifically added
// for `-wal` in attemptSnapshot.
it.skipIf(process.platform === 'win32')('reports a plain (unprefixed) error when an existing -wal file has no read permission', async () => {
  const t = seededContext()
  writeFileSync(`${t.ctx.paths.cacheDb}-wal`, 'irrelevant wal contents')
  chmodSync(`${t.ctx.paths.cacheDb}-wal`, 0o000)
  try {
    expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
    const cache = t.json().data.cache
    expect(cache.readable).toBe(false)
    expect(typeof cache.error).toBe('string')
    expect(cache.error).not.toMatch(/^could not snapshot the cache: /)
  } finally {
    chmodSync(`${t.ctx.paths.cacheDb}-wal`, 0o600)
    rmSync(`${t.ctx.paths.cacheDb}-wal`, { force: true })
  }
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
// status.ts copies the cache (and its `-wal`, if present) into a private
// temp directory and reads that copy, specifically so it never has to touch
// the real cache file or its directory at all — no `-wal`/`-shm` sidecar,
// no anything else. Verified by comparing the full directory listing next
// to the cache before and after, not just checking specific sidecar names,
// so this also fails if some other unexpected file ever showed up there.
it('leaves the cache directory listing unchanged after status on a normal, closed cache', async () => {
  const t = seededContext({ now: () => new Date('2026-09-16T08:00:00Z') })
  const dir = dirname(t.ctx.paths.cacheDb)
  const before = readdirSync(dir).sort()

  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)

  expect(readdirSync(dir).sort()).toEqual(before)
  const cache = t.json().data.cache
  expect(cache.readable).toBe(true)
  expect(cache.lastSyncAt).toBe('2026-09-15T08:00:00.000Z')
  expect(cache.ageHours).toBe(24)
})
// The snapshot-copy approach opens the COPY with a normal (non-read-only)
// connection, which lets SQLite replay `-wal` into it — so data a writer has
// committed but not yet checkpointed (the writer connection is still open,
// so no automatic checkpoint-on-close has happened) is visible to `zm
// status`, not just whatever's in the base file as of the last checkpoint.
// The directory listing must still be unchanged: only the temp-dir copy is
// touched, never the real cache or its `-wal`.
it('reads committed-but-uncheckpointed WAL data from a still-open writer, without touching the cache directory', async () => {
  const t = seededContext({ now: () => new Date('2026-09-16T08:00:00Z') })
  const writer = new DatabaseSync(t.ctx.paths.cacheDb)
  writer.exec('PRAGMA journal_mode=WAL')
  writer.exec('BEGIN IMMEDIATE')
  writer.exec(`INSERT OR REPLACE INTO meta(key, value) VALUES ('lastSyncAt', '2026-09-16T00:00:00.000Z')`)
  writer.exec('COMMIT') // committed, but the writer stays open, so nothing gets checkpointed
  try {
    const dir = dirname(t.ctx.paths.cacheDb)
    const before = readdirSync(dir).sort()

    expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)

    expect(readdirSync(dir).sort()).toEqual(before)
    const cache = t.json().data.cache
    expect(cache.readable).toBe(true)
    expect(cache.lastSyncAt).toBe('2026-09-16T00:00:00.000Z')
  } finally {
    writer.close()
  }
})
// Follow-up round item 1: a normal read-only open in a directory that isn't
// writable used to fail outright (SQLITE_READONLY_CANTINIT), because it
// couldn't create the `-shm` index it needs even just to read. The
// snapshot-copy approach sidesteps this entirely: the real cache directory
// is only ever read from (to make the copy), and the copy itself lives in a
// private temp directory that's always writable.
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
// Deterministic, non-vacuous versions of "the temp dir gets removed" live in
// tests/cli/status-snapshot.test.ts (spying on mkdtempSync itself, both on
// the success path and the corrupt-file path) rather than here: a plain
// before/after count of `zm-status-*` names in the shared OS tmpdir can't
// tell "nothing was created" apart from "something was created and removed"
// and could collide with anything else on the machine using that prefix.

// Review round item 1/6b/2: a checkpoint (or any other write) landing
// between the two `copyFileSync` calls in a single snapshot attempt can
// produce a torn, internally-inconsistent pair of files. A real concurrent
// writer that commits and lets SQLite auto-checkpoint aggressively (a small
// `wal_autocheckpoint`) is about as good a stress test for that as this
// process can run without external tooling.
//
// Follow-up round: an earlier version of this test was vacuous — its read
// loop never actually yielded to the event loop between iterations (every
// `await run(...)` here resolves via microtasks only, since `zm status`
// does no real async I/O), so the child's stdout/stderr/exit events sat
// unprocessed in libuv's queue for the entire loop and were only ever
// inspected once it was already over; and the loop could in principle run
// to completion without a single read ever actually overlapping the
// writer's activity, silently proving nothing. Fixed by: waiting for an
// explicit READY signal from the child (printed right after its first
// commit) before reading at all, an explicit `setImmediate` yield between
// every read so pipe/exit events actually get delivered along the way, and
// looping specifically UNTIL a read observes a writer-produced value
// (`lastSyncAt >= writerBaseMs`) rather than for a fixed count — if the
// deadline is hit without ever observing one, the assertion below fails
// instead of the test silently passing on seeded-but-never-updated data.
it('never regresses lastSyncAt or reports a failed integrity check under a rapidly-checkpointing concurrent writer', async () => {
  const t = seededContext()
  const writerBaseMs = Date.parse('2030-01-01T00:00:00.000Z') // well after the fixture's seeded lastSyncAt
  const child = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(t.ctx.paths.cacheDb)});
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA wal_autocheckpoint=50');
    const base = ${writerBaseMs};
    const deadline = Date.now() + 5000;
    let i = 0;
    while (Date.now() < deadline && i < 200000) {
      const iso = new Date(base + i).toISOString();
      db.exec('BEGIN IMMEDIATE');
      db.exec("INSERT OR REPLACE INTO meta(key, value) VALUES ('lastSyncAt', '" + iso + "')");
      db.exec('COMMIT');
      if (i === 0) console.log('READY'); // signal only after the first commit actually landed
      i++;
    }
    db.close();
  `])
  let childStdout = ''
  let childReady = false
  child.stdout?.on('data', chunk => {
    childStdout += chunk
    if (childStdout.includes('READY')) childReady = true
  })
  let childStderr = ''
  child.stderr?.on('data', chunk => { childStderr += chunk })
  // Registered immediately (rather than inside `finally`, after the child
  // may already have exited — e.g. crashing before ever printing READY):
  // an event that already fired before a listener is added is simply
  // never delivered to it, which would otherwise hang the `finally` below
  // forever waiting on a 'close' that's already happened.
  const childClosed = new Promise<void>(resolve => child.on('close', () => resolve()))

  try {
    const readyDeadline = Date.now() + 5000
    while (!childReady) {
      if (child.exitCode !== null) {
        throw new Error(`lock-holder child exited early (code ${child.exitCode}) before READY; stderr: ${childStderr}`)
      }
      if (Date.now() > readyDeadline) {
        throw new Error(`timed out waiting for the child's READY signal; stderr: ${childStderr}`)
      }
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    let lastSeenMs: number | null = null
    let sawWriterValue = false
    const readDeadline = Date.now() + 2000
    let reads = 0
    while (!sawWriterValue && Date.now() < readDeadline && reads < 300) {
      const code = await run(['node', 'zm', 'status'], t.ctx)
      expect(code).toBe(0)
      const cache = JSON.parse(t.out[t.out.length - 1]!).data.cache
      if (cache.readable) {
        expect(typeof cache.lastSyncAt).toBe('string')
        const ms = new Date(cache.lastSyncAt).getTime()
        if (lastSeenMs !== null) expect(ms).toBeGreaterThanOrEqual(lastSeenMs)
        lastSeenMs = ms
        if (ms >= writerBaseMs) sawWriterValue = true
      } else {
        expect(typeof cache.error).toBe('string')
      }
      reads++
      // Without this, the whole loop above resolves through microtasks
      // only and never actually yields to libuv's poll phase — see the
      // comment above this test.
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(reads).toBeGreaterThan(0)
    expect(sawWriterValue).toBe(true) // otherwise this test never exercised any real concurrency
  } finally {
    child.kill()
    await childClosed // 'close', not 'exit': guarantees stdio is fully drained first
  }

  expect(childStderr).toBe('')
  expect(child.exitCode === 0 || child.signalCode === 'SIGTERM').toBe(true) // clean run or our own kill, never a crash
}, 10_000)
