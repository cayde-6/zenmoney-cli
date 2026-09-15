import { it, expect, vi } from 'vitest'
import { writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { run } from '../../src/cli/program.js'
import { testContext } from '../helpers.js'
import { fixtureDiff } from '../fixtures/diff.js'
import { Store } from '../../src/store/store.js'
import { ZmError } from '../../src/errors.js'
import { resolveToken, type Keychain } from '../../src/auth/token.js'

function apiFetch(bodies: unknown[], calls: any[] = []) {
  return (async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body))
    return new Response(JSON.stringify(bodies.shift()), { status: 200 })
  }) as any
}

it('auth --token validates and saves to config', async () => {
  const t = testContext({ fetch: apiFetch([{ serverTimestamp: 1 }]) })
  expect(await run(['node', 'zm', 'auth', '--token', 'abc'], t.ctx)).toBe(0)
  expect(t.json().data).toEqual({ saved: 'config' })
})
it('auth warns when a keychain is available but fails, and still saves to config', async () => {
  const keychain: Keychain = {
    get: () => null,
    set: () => { throw new Error('keychain set failed') },
    remove: () => {},
  }
  const t = testContext({ fetch: apiFetch([{ serverTimestamp: 1 }]), keychain })
  expect(await run(['node', 'zm', 'auth', '--token', 'abc'], t.ctx)).toBe(0)
  expect(t.json().data).toEqual({ saved: 'config' })
  expect(t.json().warnings).toEqual([
    `could not store the token in macOS Keychain, saved to ${t.ctx.paths.configFile} instead`,
  ])
})
it('auth reads token from stdin when not a TTY', async () => {
  let capturedInit: any
  const fetchFn = (async (_url: string, init: any) => {
    capturedInit = init
    return new Response(JSON.stringify({ serverTimestamp: 1 }), { status: 200 })
  }) as any
  const t = testContext({ fetch: fetchFn, readStdin: async () => 'piped\n' })
  expect(await run(['node', 'zm', 'auth'], t.ctx)).toBe(0)
  expect(capturedInit.headers.Authorization).toBe('Bearer piped')
  expect(t.json().data).toEqual({ saved: 'config' })
})
it('auth with no --token and empty piped stdin fails fast with a clear error', async () => {
  const t = testContext({ readStdin: async () => '' })
  expect(await run(['node', 'zm', 'auth'], t.ctx)).toBe(2)
  expect(t.errJson().error).toEqual({
    code: 'INVALID_ARGS',
    message: 'no token provided',
    hint: 'pipe the token via stdin or run zm auth in a terminal',
  })
})
// The actual stdin-timeout mechanism (5s applies only until the first chunk
// arrives, stream destroyed on timeout) now lives in src/cli/context.ts's
// readStdinWithTimeout, exercised directly in tests/cli/context.test.ts and
// end-to-end in tests/e2e/bin.test.ts. This just confirms sync.ts's auth
// action propagates any ctx.readStdin() rejection (e.g. that timeout) as the
// same INVALID_ARGS error/exit code.
it('auth propagates a ctx.readStdin() rejection (e.g. a stdin timeout) as exit 2', async () => {
  const t = testContext({
    readStdin: async () => {
      throw new ZmError('INVALID_ARGS', 'no token provided', 'pipe the token via stdin or run zm auth in a terminal')
    },
  })
  expect(await run(['node', 'zm', 'auth'], t.ctx)).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'no token provided' })
})
it('auth --token with invalid characters is rejected before any network call, without leaking the token', async () => {
  let called = false
  const t = testContext({
    fetch: (async () => { called = true; return new Response(JSON.stringify({ serverTimestamp: 1 }), { status: 200 }) }) as any,
  })
  const code = await run(['node', 'zm', 'auth', '--token', 'a"b'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'token contains invalid characters' })
  expect(JSON.stringify(t.errJson())).not.toContain('a"b')
  expect(called).toBe(false)
})
it('auth reads a multi-line piped token and rejects it before any network call, without leaking the token', async () => {
  let called = false
  const t = testContext({
    fetch: (async () => { called = true; return new Response(JSON.stringify({ serverTimestamp: 1 }), { status: 200 }) }) as any,
    readStdin: async () => 'REALTOKEN\nsecond',
  })
  const code = await run(['node', 'zm', 'auth'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'token contains invalid characters' })
  expect(JSON.stringify(t.errJson())).not.toContain('REALTOKEN')
  expect(called).toBe(false)
})
it('auth with rejected token exits 3 and saves nothing', async () => {
  const t = testContext({ fetch: (async () => new Response('', { status: 401 })) as any })
  expect(await run(['node', 'zm', 'auth', '--token', 'bad'], t.ctx)).toBe(3)
  const t2 = testContext({ paths: t.ctx.paths })
  expect(await run(['node', 'zm', 'sync'], t2.ctx)).toBe(3)
})
it('sync without token exits 3', async () => {
  const t = testContext()
  expect(await run(['node', 'zm', 'sync'], t.ctx)).toBe(3)
  expect(t.errJson().error.hint).toMatch(/zm auth/)
})
it('first sync sends 0, next sync sends stored serverTimestamp, --full resets', async () => {
  const calls: any[] = []
  const t = testContext({ env: { ZENMONEY_TOKEN: 'tok' }, fetch: apiFetch([fixtureDiff(), { serverTimestamp: 1789000999 }, fixtureDiff()], calls) })
  expect(await run(['node', 'zm', 'sync'], t.ctx)).toBe(0)
  expect(t.json().data.upserted.transaction).toBe(23)
  t.out.length = 0
  expect(await run(['node', 'zm', 'sync'], t.ctx)).toBe(0)
  t.out.length = 0
  expect(await run(['node', 'zm', 'sync', '--full'], t.ctx)).toBe(0)
  expect(calls.map(c => c.serverTimestamp)).toEqual([0, 1789000000, 0])
  expect(t.json().data.full).toBe(true)
  // --full's reset+reapply happened in one transaction: the store has exactly the
  // fresh diff's rows, not the old ones plus a duplicate re-insert.
  const store = Store.open(t.ctx.paths.cacheDb)
  try {
    expect(store.all('transaction').length).toBe(23)
  } finally {
    store.close()
  }
})
it('sync --full does not wipe the cache when the fetch fails', async () => {
  const t = testContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  const seed = Store.open(t.ctx.paths.cacheDb)
  seed.applyDiff(fixtureDiff(), new Date('2026-09-14T00:00:00Z'))
  seed.close()

  const failing = testContext({
    env: { ZENMONEY_TOKEN: 'tok' },
    paths: t.ctx.paths,
    fetch: (async () => { throw new TypeError('fetch failed') }) as any,
  })
  expect(await run(['node', 'zm', 'sync', '--full'], failing.ctx)).toBe(4)

  const store = Store.open(t.ctx.paths.cacheDb)
  try {
    expect(store.hasData()).toBe(true)
    expect(store.all('transaction').length).toBe(23)
  } finally {
    store.close()
  }
})
it('auth --logout warns when ZENMONEY_TOKEN is still set in the environment', async () => {
  const t = testContext({ env: { ZENMONEY_TOKEN: 'still-here' } })
  expect(await run(['node', 'zm', 'auth', '--logout'], t.ctx)).toBe(0)
  expect(t.json().warnings).toEqual(['ZENMONEY_TOKEN is still set in the environment and will be used'])
})
it('auth --logout does not warn when ZENMONEY_TOKEN is not set', async () => {
  const t = testContext()
  expect(await run(['node', 'zm', 'auth', '--logout'], t.ctx)).toBe(0)
  expect(t.json().warnings).toBeUndefined()
})
// `removeToken` itself is already unit-tested (tests/auth/token.test.ts);
// these two exercise the CLI's own `auth --logout` wiring end to end for
// each storage path, asserting on the actual saved/removed state rather
// than just the exit code.
it('auth --logout removes the token from config.json when it was stored there', async () => {
  const t = testContext({ fetch: apiFetch([{ serverTimestamp: 1 }]) })
  expect(await run(['node', 'zm', 'auth', '--token', 'sekret'], t.ctx)).toBe(0) // testContext has no keychain -> saved to config
  expect(JSON.parse(readFileSync(t.ctx.paths.configFile, 'utf8'))).toEqual({ token: 'sekret' })

  expect(await run(['node', 'zm', 'auth', '--logout'], t.ctx)).toBe(0)
  expect(JSON.parse(readFileSync(t.ctx.paths.configFile, 'utf8'))).toEqual({})
})
it('auth --logout removes the token from the Keychain, and resolveToken then finds nothing', async () => {
  let stored: string | null = 'kc-token'
  const keychain: Keychain = {
    get: () => stored,
    set: v => { stored = v },
    remove: () => { stored = null },
  }
  const t = testContext({ keychain })
  expect(await run(['node', 'zm', 'auth', '--logout'], t.ctx)).toBe(0)
  expect(stored).toBeNull()
  expect(resolveToken({ env: {}, keychain, configFile: t.ctx.paths.configFile })).toBeNull()
})
it('sync --full recovers from a corrupted cache file by deleting and recreating it', async () => {
  const t = testContext({ env: { ZENMONEY_TOKEN: 'tok' }, fetch: apiFetch([fixtureDiff()]) })
  mkdirSync(dirname(t.ctx.paths.cacheDb), { recursive: true })
  writeFileSync(t.ctx.paths.cacheDb, 'not a sqlite file')
  expect(await run(['node', 'zm', 'sync', '--full'], t.ctx)).toBe(0)
  expect(t.json().data.upserted.transaction).toBe(23)
})
it('sync without --full surfaces NO_CACHE (exit 5) for a corrupted cache file, without touching it', async () => {
  const t = testContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  mkdirSync(dirname(t.ctx.paths.cacheDb), { recursive: true })
  writeFileSync(t.ctx.paths.cacheDb, 'not a sqlite file')
  expect(await run(['node', 'zm', 'sync'], t.ctx)).toBe(5)
  expect(t.errJson().error).toMatchObject({ code: 'NO_CACHE' })
})
it('sync rejects an invalid ZM_TIMEOUT_MS before opening the cache', async () => {
  const t = testContext({ env: { ZENMONEY_TOKEN: 'tok', ZM_TIMEOUT_MS: 'nope' } })
  expect(await run(['node', 'zm', 'sync'], t.ctx)).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS' })
})
// Review round item 3: asserting only `signal instanceof AbortSignal` proves
// nothing about whether ZM_TIMEOUT_MS's value actually reached fetchDiff — a
// build that silently dropped it and always used the 60s default would still
// pass. Spying on the real AbortSignal.timeout factory proves the configured
// value is what's actually used.
it('sync passes ZM_TIMEOUT_MS through to the network call', async () => {
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
  const fetchFn = (async () => new Response(JSON.stringify({ serverTimestamp: 1 }), { status: 200 })) as any
  const t = testContext({ env: { ZENMONEY_TOKEN: 'tok', ZM_TIMEOUT_MS: '1234' }, fetch: fetchFn })
  expect(await run(['node', 'zm', 'sync'], t.ctx)).toBe(0)
  expect(timeoutSpy).toHaveBeenCalledWith(1234)
  timeoutSpy.mockRestore()
})
// Review round item 1(b): CLI-level — `zm sync`'s applyDiff must exit 6
// (CACHE_BUSY) when the cache is locked by another connection, not crash
// with an unhandled sqlite error (exit 1).
it('sync exits 6 (CACHE_BUSY) when the cache is locked by another connection', async () => {
  const t = testContext({ env: { ZENMONEY_TOKEN: 'tok' }, fetch: apiFetch([fixtureDiff()]) })
  // Seed the cache first so it's already in WAL mode (matching real usage:
  // the file exists from a prior sync).
  const seed = Store.open(t.ctx.paths.cacheDb)
  seed.applyDiff(fixtureDiff(), new Date('2026-09-14T00:00:00Z'))
  seed.close()

  const blocker = new DatabaseSync(t.ctx.paths.cacheDb)
  blocker.exec('PRAGMA journal_mode=WAL')
  blocker.exec('BEGIN IMMEDIATE')
  blocker.exec(`INSERT OR REPLACE INTO "user"(id, raw) VALUES ('999', '{}')`)
  try {
    expect(await run(['node', 'zm', 'sync'], t.ctx)).toBe(6)
    expect(t.errJson().error).toMatchObject({ code: 'CACHE_BUSY' })
  } finally {
    blocker.exec('ROLLBACK')
    blocker.close()
  }
}, 8000)
// Review round item 6: a distinct sqlite failure (here SQLITE_READONLY) must
// not be mistaken for corruption — `sync --full` must not delete the cache
// file for it, since the file itself is fine.
it('sync --full does not delete the cache file on a non-corruption sqlite failure (read-only fs)', async () => {
  const t = testContext({ env: { ZENMONEY_TOKEN: 'tok' }, fetch: apiFetch([fixtureDiff()]) })
  const seed = Store.open(t.ctx.paths.cacheDb)
  seed.applyDiff(fixtureDiff(), new Date('2026-09-14T00:00:00Z'))
  seed.close()
  const before = readFileSync(t.ctx.paths.cacheDb)

  chmodSync(t.ctx.paths.cacheDb, 0o400)
  try {
    const code = await run(['node', 'zm', 'sync', '--full'], t.ctx)
    expect(code).toBe(1)
    expect(t.errJson().error).toMatchObject({ code: 'UNEXPECTED' })
  } finally {
    chmodSync(t.ctx.paths.cacheDb, 0o600)
  }
  // The file must still exist, unchanged — not deleted-and-recreated the way
  // a genuinely corrupted cache would be.
  expect(readFileSync(t.ctx.paths.cacheDb)).toEqual(before)
})
it('auth --token trimming down to nothing (whitespace only) is rejected as an empty token', async () => {
  const t = testContext()
  const code = await run(['node', 'zm', 'auth', '--token', '   '], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'empty token' })
})
// `zm sync` end to end: a diff containing a `deletion` entry (not just
// upserts) must actually remove the row from the cache and surface the
// count in the printed stats — Store.applyDiff's own deletion handling is
// unit-tested in tests/store/store.test.ts, but the CLI wiring that passes
// the fetched diff's `deletion` array through untouched was not.
it('sync applies a deletion from the fetched diff, removing the row and reporting it', async () => {
  const t = testContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  const seed = Store.open(t.ctx.paths.cacheDb)
  seed.applyDiff(fixtureDiff(), new Date('2026-09-14T00:00:00Z'))
  expect(seed.all('transaction').some(row => row.id === 't1')).toBe(true)
  seed.close()

  const deletingDiff = { serverTimestamp: 1789001000, deletion: [{ id: 't1', object: 'transaction', stamp: 1789001000, user: 10 }] }
  const t2 = testContext({ env: { ZENMONEY_TOKEN: 'tok' }, paths: t.ctx.paths, fetch: apiFetch([deletingDiff]) })
  expect(await run(['node', 'zm', 'sync'], t2.ctx)).toBe(0)
  expect(t2.json().data.deleted).toBe(1)

  const store = Store.open(t.ctx.paths.cacheDb)
  try {
    expect(store.all('transaction').some(row => row.id === 't1')).toBe(false)
  } finally {
    store.close()
  }
})
