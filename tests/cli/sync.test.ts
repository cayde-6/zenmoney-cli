import { it, expect } from 'vitest'
import { run } from '../../src/cli/program.js'
import { testContext } from '../helpers.js'
import { fixtureDiff } from '../fixtures/diff.js'
import { Store } from '../../src/store/store.js'
import { ZmError } from '../../src/errors.js'

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
  expect(t.json().data.upserted.transaction).toBe(19)
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
    expect(store.all('transaction').length).toBe(19)
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
    expect(store.all('transaction').length).toBe(19)
  } finally {
    store.close()
  }
})
