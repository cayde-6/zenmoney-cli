import { it, expect } from 'vitest'
import { writeFileSync, readFileSync, mkdirSync, statSync, existsSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
// The private temp directory status.ts creates to hold the cache copy must
// not accumulate across runs — it's removed in a `finally`, regardless of
// whether the read succeeded. Checked by prefix in the OS temp dir rather
// than tracking the exact path (which status.ts doesn't expose), since a
// stable count of `zm-status-*` entries before and after is enough to prove
// nothing was left behind by this run.
it('removes its private temp dir after status finishes', async () => {
  const t = seededContext()
  const before = readdirSync(tmpdir()).filter(name => name.startsWith('zm-status-')).sort()

  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)

  const after = readdirSync(tmpdir()).filter(name => name.startsWith('zm-status-')).sort()
  expect(after).toEqual(before)
})
