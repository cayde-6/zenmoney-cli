import { it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { withStore } from '../../src/cli/program.js'
import { testContext, fixtureStore } from '../helpers.js'
import { Store } from '../../src/store/store.js'
import { fixtureDiff } from '../fixtures/diff.js'

// withStore has no consumer yet in this task (the first read command arrives in
// Task 4), so it's exercised directly against a minimal fake Command that only
// needs to answer optsWithGlobals() for formatOf().
function fakeCmd(): Command {
  return { optsWithGlobals: () => ({ format: 'json' }) } as unknown as Command
}

it('throws NO_CACHE for an empty sqlite file left by a failed sync', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-store-'))
  const file = join(dir, 'zm.sqlite')
  Store.open(file).close() // schema-only file, no rows

  const t = testContext({ openStore: () => Store.open(file) })
  expect(() => withStore(t.ctx, fakeCmd(), store => ({ data: store.all('user') }))).toThrow(
    expect.objectContaining({ code: 'NO_CACHE' }),
  )
})

it('warns when the cache is stale', () => {
  const store = Store.memory()
  store.applyDiff(fixtureDiff(), new Date('2026-09-12T00:00:00Z')) // 3d12h before ctx.now()
  const t = testContext({ openStore: () => store, now: () => new Date('2026-09-15T12:00:00Z') })

  withStore(t.ctx, fakeCmd(), s => ({ data: s.all('user') }))

  expect(t.json().warnings).toEqual(['cache is 3 days old, run zm sync'])
})

it('does not warn when the cache is fresh', () => {
  const store = fixtureStore() // synced 2026-09-15T08:00:00Z
  const t = testContext({ openStore: () => store, now: () => new Date('2026-09-15T12:00:00Z') })

  withStore(t.ctx, fakeCmd(), s => ({ data: s.all('user') }))

  expect(t.json().warnings).toBeUndefined()
})

it('closes the store even when fn throws', () => {
  const store = fixtureStore()
  let closed = false
  const originalClose = store.close.bind(store)
  store.close = () => { closed = true; originalClose() }
  const t = testContext({ openStore: () => store })

  expect(() => withStore(t.ctx, fakeCmd(), () => { throw new Error('boom') })).toThrow('boom')
  expect(closed).toBe(true)
})
