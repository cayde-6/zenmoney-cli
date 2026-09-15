import { it, expect, vi, beforeEach, afterEach } from 'vitest'

// Isolated in its own file (same rationale as
// tests/auth/token-atomic-write.test.ts) because it mocks node:fs (and, for
// the quick_check test, node:sqlite) for the whole module graph this file
// imports — mixing that with tests/cli/status.test.ts's many tests that
// rely on real fs/sqlite behavior would make nearly all of them fail too.
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    mkdtempSync: vi.fn(actual.mkdtempSync),
    statSync: vi.fn(actual.statSync),
    copyFileSync: vi.fn(actual.copyFileSync),
  }
})

// A hoisted, mutable toggle so individual tests can make the *next* database
// opened by status.ts report a chosen `PRAGMA quick_check` result, without
// every other test in this file (which needs the real sqlite behavior) also
// going through the fake. `vi.hoisted` is required here rather than a plain
// module-level `let`: `vi.mock` factories run before the rest of the module
// body, so a factory can only close over state created the same way.
const quickCheckOverride = vi.hoisted(() => ({ result: null as string | null }))

vi.mock('node:sqlite', async () => {
  const actual = await vi.importActual<typeof import('node:sqlite')>('node:sqlite')
  // `Store` (used by tests/helpers.ts's seededContext) drives a real
  // DatabaseSync through many methods (exec, prepare, close, ...), so this
  // can't just re-implement a couple of methods by hand without silently
  // breaking whichever one it forgot — a Proxy delegates every property to
  // a real instance by default, with `prepare` intercepted only for the one
  // specific query a test has opted into overriding via `quickCheckOverride`.
  // Built as a plain function rather than a `class`, so `new DatabaseSync(...)`
  // can return the Proxy directly (a constructor function's explicit object
  // return value replaces the implicit `this` under `new`), sidestepping any
  // issue accessing a `class`'s private fields through the Proxy.
  function DatabaseSyncWithOverride(this: unknown, ...args: unknown[]) {
    const real = new (actual.DatabaseSync as unknown as new (...a: unknown[]) => InstanceType<typeof actual.DatabaseSync>)(...args)
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (quickCheckOverride.result !== null && typeof sql === 'string' && sql.trim() === 'PRAGMA quick_check') {
              const result = quickCheckOverride.result
              // Only `.get()` is ever called on the result of this specific
              // query by status.ts — a minimal stand-in is enough.
              return { get: () => ({ quick_check: result }) }
            }
            return target.prepare(sql)
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  return { ...actual, DatabaseSync: DatabaseSyncWithOverride }
})

beforeEach(async () => {
  const fs = await import('node:fs')
  vi.mocked(fs.mkdtempSync).mockClear()
  vi.mocked(fs.mkdtempSync).mockImplementation(actualFs.mkdtempSync)
  vi.mocked(fs.statSync).mockClear()
  vi.mocked(fs.statSync).mockImplementation(actualFs.statSync)
  vi.mocked(fs.copyFileSync).mockClear()
  vi.mocked(fs.copyFileSync).mockImplementation(actualFs.copyFileSync)
  quickCheckOverride.result = null
})
afterEach(() => { vi.restoreAllMocks() })

// `testContext`/`seededContext` (tests/helpers.ts) call the real
// `mkdtempSync` themselves to build each test's isolated home directory —
// that call gets captured by this file's spy too, so results are filtered
// down to status.ts's own `zm-status-` snapshot dirs before asserting
// anything about creation/removal.
function statusTempDirsCreated(mock: ReturnType<typeof vi.mocked<typeof actualFs.mkdtempSync>>): string[] {
  return mock.mock.results.map(r => r.value as string).filter(dir => dir.includes('zm-status-'))
}

// Review round item 6a: the temp-dir-cleanup test must actually prove
// something was created and then removed, not just that no *known* prefix
// survives (which would also "pass" if nothing were ever created at all,
// or if some unrelated process's directory happened to share the prefix).
// Spying on mkdtempSync itself and checking exactly the paths it returned
// sidesteps both problems, and can't collide with anything else on the
// machine creating similarly-prefixed directories concurrently (e.g. the
// e2e suite).
it('creates then removes its private temp dir on a successful read', async () => {
  const fs = await import('node:fs')
  const { run } = await import('../../src/cli/program.js')
  const { seededContext } = await import('../helpers.js')
  const t = seededContext()

  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)

  const created = statusTempDirsCreated(vi.mocked(fs.mkdtempSync))
  expect(created.length).toBeGreaterThan(0)
  for (const dir of created) expect(actualFs.existsSync(dir)).toBe(false)
  expect(t.json().data.cache.readable).toBe(true)
})
it('creates then removes its private temp dir on the corrupt-file path too', async () => {
  const fs = await import('node:fs')
  const { run } = await import('../../src/cli/program.js')
  const { testContext } = await import('../helpers.js')
  const { dirname } = await import('node:path')
  const t = testContext()
  actualFs.mkdirSync(dirname(t.ctx.paths.cacheDb), { recursive: true })
  actualFs.writeFileSync(t.ctx.paths.cacheDb, 'not a sqlite file')

  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)

  const created = statusTempDirsCreated(vi.mocked(fs.mkdtempSync))
  expect(created.length).toBeGreaterThan(0)
  for (const dir of created) expect(actualFs.existsSync(dir)).toBe(false)
  expect(t.json().data.cache.readable).toBe(false)
})

// Review round item 6c: the before/after stability check (status.ts's
// `snapshotsMatch`) must actually cause a retry (fresh temp dir, up to
// MAX_SNAPSHOT_ATTEMPTS) when the cache appears to have changed mid-copy,
// and give up with the documented message once every attempt sees the same
// "it changed" result — exercised deterministically here via a mocked
// `statSync` that reports a different `mtimeMs` on every single call, so
// the "before" and "after" snapshot within every attempt always disagree,
// rather than relying on timing a real concurrent writer.
it('retries the snapshot on an unstable stat, then reports readable:false once attempts are exhausted', async () => {
  const fs = await import('node:fs')
  const { run } = await import('../../src/cli/program.js')
  const { seededContext } = await import('../helpers.js')
  const t = seededContext()

  let counter = 0
  vi.mocked(fs.statSync).mockImplementation(((...args: unknown[]) => {
    counter++
    const real = (actualFs.statSync as (...a: unknown[]) => import('node:fs').Stats)(...args)
    // A fresh, ever-increasing mtimeMs on every call guarantees the
    // "before" and "after" call within a single attempt never match, no
    // matter how many attempts run.
    return { ...real, mtimeMs: real.mtimeMs + counter }
  }) as typeof actualFs.statSync)

  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)

  const cache = t.json().data.cache
  expect(cache.readable).toBe(false)
  expect(cache.error).toBe('cache is being written by another process, retry shortly')

  // Exactly 3 attempts (MAX_SNAPSHOT_ATTEMPTS): a fresh temp dir per
  // attempt, each removed again, and two statSync calls against the real
  // cache path per attempt (before the copy, after the copy).
  const created = statusTempDirsCreated(vi.mocked(fs.mkdtempSync))
  expect(created).toHaveLength(3)
  for (const dir of created) expect(actualFs.existsSync(dir)).toBe(false)
  const statCallsOnCache = vi.mocked(fs.statSync).mock.calls.filter(args => args[0] === t.ctx.paths.cacheDb)
  expect(statCallsOnCache).toHaveLength(6)
})

// Review round item 5 (and item 1's follow-up correction): mkdtempSync
// failing is always a local-temp-side problem — by the time it's called,
// the real cache (and its `-wal`, if any) has already been confirmed
// readable via `accessSync`, and mkdtempSync itself never touches the real
// cache at all — so it always gets the "could not snapshot the cache: "
// prefix, regardless of its error code (unlike a copy failure, which only
// qualifies for the prefix on specific codes — covered separately below,
// since a copy failure's error code is the only signal available once
// `.dest` was found not to reliably indicate which side failed).
it('prefixes any mkdtemp failure as a local snapshot problem, not a cache problem', async () => {
  const fs = await import('node:fs')
  const { run } = await import('../../src/cli/program.js')
  const { seededContext } = await import('../helpers.js')
  const t = seededContext()

  vi.mocked(fs.mkdtempSync).mockImplementationOnce(() => {
    // A code that would NOT qualify for the temp-side prefix if this were
    // a copyFileSync failure (see isLikelyTempSideError) — proving mkdtemp
    // is treated unconditionally, not via the same code-based check.
    const err = new Error('simulated unexpected mkdtemp failure') as NodeJS.ErrnoException
    err.code = 'EMFILE'
    throw err
  })

  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  const cache = t.json().data.cache
  expect(cache.readable).toBe(false)
  expect(cache.error).toBe('could not snapshot the cache: simulated unexpected mkdtemp failure')
})

// Review round item 2: the `-wal` file existing when `before` is taken but
// disappearing by the time it's actually copied (a writer checkpointed and
// removed it in between) must retry with a fresh snapshot, not report
// unreadable — exercised by making the very first attempt's `-wal` copy
// throw ENOENT while a real `-wal` file is present throughout, so the
// second attempt's copy (same mocked function, real behavior by then)
// succeeds normally.
it('retries (rather than failing) when -wal disappears between the before-stat and its copy', async () => {
  const fs = await import('node:fs')
  const { run } = await import('../../src/cli/program.js')
  const { seededContext } = await import('../helpers.js')
  const t = seededContext({ now: () => new Date('2026-09-16T08:00:00Z') })
  // A real -wal file so `before.walHeader !== null` and status.ts actually
  // attempts to copy it (32+ arbitrary bytes: only the header is read).
  actualFs.writeFileSync(`${t.ctx.paths.cacheDb}-wal`, Buffer.alloc(64, 1))

  let walCopyAttempts = 0
  vi.mocked(fs.copyFileSync).mockImplementation(((...args: unknown[]) => {
    const [src, dest] = args as [string, string]
    if (dest.endsWith('-wal')) {
      walCopyAttempts++
      if (walCopyAttempts === 1) {
        const err = new Error(`ENOENT: no such file or directory, copyfile '${src}'`) as NodeJS.ErrnoException
        err.code = 'ENOENT'
        err.path = src
        throw err
      }
    }
    return (actualFs.copyFileSync as (...a: unknown[]) => void)(...args)
  }) as typeof actualFs.copyFileSync)

  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  const cache = t.json().data.cache
  expect(cache.readable).toBe(true)
  expect(cache.lastSyncAt).toBe('2026-09-15T08:00:00.000Z')
  expect(walCopyAttempts).toBeGreaterThanOrEqual(2) // the disappearance was retried, not fatal

  actualFs.rmSync(`${t.ctx.paths.cacheDb}-wal`, { force: true })
})

// Review round item 5: ENOSPC/EACCES writing into the temp copy itself
// (not the real cache) is a local snapshot problem, distinguished via
// copyFileSync's `.dest` (the destination it failed to write).
it('prefixes a temp-side copy failure (ENOSPC/EACCES writing the copy) as a local snapshot problem', async () => {
  const fs = await import('node:fs')
  const { run } = await import('../../src/cli/program.js')
  const { seededContext } = await import('../helpers.js')
  const t = seededContext()

  vi.mocked(fs.copyFileSync).mockImplementationOnce(((...args: unknown[]) => {
    const [, dest] = args as [string, string]
    const err = new Error(`EACCES: permission denied, copyfile -> '${dest}'`) as NodeJS.ErrnoException & { dest?: string }
    err.code = 'EACCES'
    err.dest = dest
    throw err
  }) as typeof actualFs.copyFileSync)

  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  const cache = t.json().data.cache
  expect(cache.readable).toBe(false)
  expect(cache.error).toMatch(/^could not snapshot the cache: /)
})
// A copy failure that's neither the -wal-disappeared race nor a
// recognized temp-side code/destination is a genuine, unclassified
// problem and is reported as-is, with no retry.
it('reports an unrecognized copy failure as-is, without retrying', async () => {
  const fs = await import('node:fs')
  const { run } = await import('../../src/cli/program.js')
  const { seededContext } = await import('../helpers.js')
  const t = seededContext()

  vi.mocked(fs.copyFileSync).mockImplementationOnce(() => {
    const err = new Error('simulated I/O error copying the cache') as NodeJS.ErrnoException
    err.code = 'EIO'
    throw err
  })

  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  const cache = t.json().data.cache
  expect(cache.readable).toBe(false)
  expect(cache.error).toBe('simulated I/O error copying the cache')
})

// Review round item 1: `PRAGMA quick_check` returning anything other than
// 'ok' (rather than throwing, which the corrupted-file test already covers)
// must also report readable:false — real-world data corruption subtle
// enough to reach this rather than an outright open/read failure is hard to
// construct on demand, so this drives it directly via the mocked
// `DatabaseSync` above.
//
// Review round item 3: a quick_check failure is retried like an unstable
// snapshot (it most likely means a tear the before/after stability check's
// coarser size/mtime comparison missed), not reported immediately — so
// with `quickCheckOverride.result` fixed for the whole test, every one of
// the 3 attempts sees the same "bad" result, and only once they're all
// exhausted does readCacheInfo report it as the final error. Asserting the
// temp-dir count is what actually proves the retry happened, rather than
// this just coincidentally being a single-attempt failure with the same
// message.
it('retries a quick_check failure like an unstable snapshot, reporting it only once attempts are exhausted', async () => {
  const fs = await import('node:fs')
  const { run } = await import('../../src/cli/program.js')
  const { seededContext } = await import('../helpers.js')
  const t = seededContext()

  quickCheckOverride.result = 'row 3 missing from index meta'

  expect(await run(['node', 'zm', 'status'], t.ctx)).toBe(0)
  const cache = t.json().data.cache
  expect(cache.readable).toBe(false)
  expect(cache.error).toBe('cache integrity check failed: row 3 missing from index meta')

  const created = statusTempDirsCreated(vi.mocked(fs.mkdtempSync))
  expect(created).toHaveLength(3) // MAX_SNAPSHOT_ATTEMPTS: it really did retry, not fail once
  for (const dir of created) expect(actualFs.existsSync(dir)).toBe(false)
})
