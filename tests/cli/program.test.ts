import { it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { run, buildProgram, staleWarnings, readVersion } from '../../src/cli/program.js'
import { testContext, seededContext } from '../helpers.js'

it('prints version', async () => {
  const t = testContext()
  expect(await run(['node', 'zm', '--version'], t.ctx)).toBe(0)
  expect(t.out.join('')).toMatch(/\d+\.\d+\.\d+/)
})
it('unknown command exits 2 with json error', async () => {
  const t = testContext()
  expect(await run(['node', 'zm', 'nope'], t.ctx)).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
})
it('error format detection: only a real --format table triggers table output, not an unrelated "table" argument', async () => {
  const t = seededContext()
  const code = await run(['node', 'zm', 'tx', '--format', 'json', '--category', 'table', '--month', '2026-13'], t.ctx)
  expect(code).toBe(2)
  expect(() => t.errJson()).not.toThrow() // still valid JSON on stderr, not text
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
})
it('error format detection: --format=table is recognised', async () => {
  const t = seededContext()
  const code = await run(['node', 'zm', 'tx', '--format=table', '--month', '2026-13'], t.ctx)
  expect(code).toBe(2)
  expect(t.err.join('')).toMatch(/^error: /)
})
// A-20: singular/plural grammar ("1 day old" vs "N days old").
it('staleWarnings uses singular "day" for exactly one day, plural otherwise', () => {
  const ctx = testContext({ now: () => new Date('2026-09-16T12:00:00Z') }).ctx // 1 day 4h after lastSyncAt
  expect(staleWarnings(ctx, '2026-09-15T08:00:00Z')).toEqual(['cache is 1 day old, run zm sync'])
  const ctx3 = testContext({ now: () => new Date('2026-09-18T09:00:00Z') }).ctx // ~3 days after
  expect(staleWarnings(ctx3, '2026-09-15T08:00:00Z')).toEqual(['cache is 3 days old, run zm sync'])
})
it('staleWarnings returns no warnings when there has never been a sync', () => {
  const ctx = testContext().ctx
  expect(staleWarnings(ctx, null)).toEqual([])
})
// errorFormat (private to program.ts, exercised only through run()'s catch path):
// a real `--format table`/`--format=table` must be recognised regardless of
// how commander itself failed to parse the rest of argv.
it('error format detection: bare "--format table" as two separate argv entries is recognised', async () => {
  const t = seededContext()
  const code = await run(['node', 'zm', '--format', 'table', 'nope'], t.ctx)
  expect(code).toBe(2)
  expect(t.err.join('')).toMatch(/^error: /)
})
it('error format detection: a trailing "--format" with no value does not crash and falls back to json', async () => {
  const t = seededContext()
  const code = await run(['node', 'zm', 'nope', '--format'], t.ctx)
  expect(code).toBe(2)
  expect(() => t.errJson()).not.toThrow()
})
// readVersion() falls back to '0.0.0' when the resolved package.json has no
// version field. findPackageRoot()'s own require() call and readVersion()'s
// share Node's global CJS module cache (require.cache), keyed by the
// resolved absolute path — swapping that cache entry for a fake, unversioned
// package object exercises the `pkg.version ?? '0.0.0'` fallback without
// touching the real package.json on disk.
it('readVersion falls back to "0.0.0" when package.json has no version field', () => {
  const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
  const req = createRequire(import.meta.url)
  const resolved = req.resolve(pkgPath)
  const original = req.cache[resolved]
  req.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { name: '@cayde-6/zenmoney-cli' } } as unknown as NodeModule
  try {
    expect(readVersion()).toBe('0.0.0')
  } finally {
    if (original) req.cache[resolved] = original
    else delete req.cache[resolved]
  }
})
it('bare invocation with a subcommand registered exits non-zero and writes help to stderr', async () => {
  // The real buildProgram(ctx) would also reproduce this (a bare `zm` prints
  // help and exits 2 once any subcommand is registered), but injecting a
  // minimal one-command program via run()'s test-only `build` override keeps
  // this test isolated from the real command list, so it only exercises
  // run()'s own exitCode-aware catch path.
  const t = testContext()
  const code = await run(['node', 'zm'], t.ctx, ctx => {
    const program = buildProgram(ctx)
    program.command('dummy').action(() => {})
    return program
  })
  expect(code).toBe(2)
  expect(t.out.join('')).toBe('')
  expect(t.err.join('')).toMatch(/Usage: zm/)
})
