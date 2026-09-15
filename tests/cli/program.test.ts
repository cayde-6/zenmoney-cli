import { it, expect } from 'vitest'
import { run, buildProgram } from '../../src/cli/program.js'
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
it('bare invocation with a subcommand registered exits non-zero and writes help to stderr', async () => {
  // buildProgram(ctx) itself registers no subcommands in this task, so this scenario
  // (bare `zm` triggering commander's own "show help, exit 1" behavior) can't be
  // reproduced through the real program yet. Inject a program with one dummy
  // subcommand via run()'s test-only `build` override to exercise the same
  // exitCode-aware catch path that a future task's real subcommands will hit.
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
