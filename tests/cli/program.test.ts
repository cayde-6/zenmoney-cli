import { it, expect } from 'vitest'
import { run, buildProgram, staleWarnings } from '../../src/cli/program.js'
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
