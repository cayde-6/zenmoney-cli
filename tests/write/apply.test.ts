import { it, expect, vi } from 'vitest'
import { runWrite, type Planner } from '../../src/write/apply.js'
import { planAdd, planDelete, planEdit } from '../../src/write/plan.js'
import { seededContext, fixtureStore } from '../helpers.js'
import { fixtureDiff } from '../fixtures/diff.js'
import { apiFetch } from './fakeApi.js'
import { Store } from '../../src/store/store.js'
import type { ZmTransaction } from '../../src/api/types.js'

const NOW = new Date('2026-09-15T12:00:00')
const NOW_SEC = Math.floor(NOW.getTime() / 1000)
const T1_CHANGED = 1780000000

// Edits t1's comment, looked up fresh from the store each time it's called
// (both in dry-run and post-sync) so the mismatch/already-applied tests can
// observe the effect of a sync landing a change on t1 in between.
const editT1: Planner = (store, ds) => planEdit(ds, [store.getTransaction('t1')!], { comment: 'New' })

const editT1AndT4: Planner = (store, ds) => planEdit(ds, [store.getTransaction('t1')!, store.getTransaction('t4')!], { comment: 'New' })

const noopThrowFetch = (async () => { throw new Error('must not fetch') }) as unknown as typeof fetch

it('dry-run: no fetch call, applied false, applyCommand contains --expect <token>', async () => {
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, fetch: noopThrowFetch })
  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: false, expect: undefined, plan: editT1 })
  const { data } = t.json()
  expect(data.applied).toBe(false)
  expect(data.token).toMatch(/^[0-9a-f]{16}$/)
  expect(data.applyCommand).toBe(`zm edit t1 --comment New --apply --expect ${data.token}`)
})

it('dry-run warns "nothing to change" when every target already matches the planned state, applyCommand null', async () => {
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, fetch: noopThrowFetch })
  const samePlan: Planner = (store, ds) => planEdit(ds, [store.getTransaction('t1')!], { accountId: 'acc-pln' })
  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--account', 'acc-pln'], apply: false, expect: undefined, plan: samePlan })
  const { data, warnings } = t.json()
  expect(warnings).toContain('nothing to change: already in that state')
  expect(data.applyCommand).toBeNull()
})

it('--apply without --expect throws INVALID_ARGS before opening the store', async () => {
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, fetch: noopThrowFetch })
  await expect(
    runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: true, expect: undefined, plan: editT1 }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' })
})

it('apply success: pushes against the post-sync serverTimestamp with a skew-guarded changed, updates the cache, prints applied true', async () => {
  const calls: any[] = []
  const changed = Math.max(NOW_SEC, T1_CHANGED + 1)
  const pushedT1 = { ...fixtureStore().getTransaction('t1')!, comment: 'New', changed }
  const syncResponse = { ...fixtureDiff(), serverTimestamp: 1789000050 }
  const pushResponse = { serverTimestamp: 1789000100, transaction: [pushedT1] }
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: apiFetch([syncResponse, pushResponse], calls) })

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: false, expect: undefined, plan: editT1 })
  const token = t.json().data.token
  t.out.length = 0

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: true, expect: token, plan: editT1 })

  expect(calls).toHaveLength(2)
  expect(calls[0].serverTimestamp).toBe(1789000000) // pre-sync store serverTimestamp
  expect(calls[1].serverTimestamp).toBe(1789000050) // post-sync store serverTimestamp
  expect(calls[1].transaction).toHaveLength(1)
  expect(calls[1].transaction[0].comment).toBe('New')
  expect(calls[1].transaction[0].changed).toBe(changed)
  // An edit keeps the target's original `created` — only a `create`'s
  // payload gets `created` overridden (see the create-payload test below).
  expect(calls[1].transaction[0].created).toBe(1780000000)

  const store = Store.open(t.ctx.paths.cacheDb)
  try {
    expect(store.getTransaction('t1')?.comment).toBe('New')
  } finally {
    store.close()
  }

  const out = t.json()
  expect(out.data.applied).toBe(true)
  expect(out.data.applyCommand).toBeNull()
})

it('token mismatch (data changed since the dry-run) exits CONFLICT with only the sync call made', async () => {
  const calls: any[] = []
  const t1 = fixtureStore().getTransaction('t1')!
  const syncResponse = { serverTimestamp: 1789000050, transaction: [{ ...t1, changed: 1780000555 }] }
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: apiFetch([syncResponse], calls) })

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: false, expect: undefined, plan: editT1 })
  const token = t.json().data.token
  t.out.length = 0

  await expect(
    runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: true, expect: token, plan: editT1 }),
  ).rejects.toMatchObject({ code: 'CONFLICT', message: 'the data changed since the dry-run' })
  expect(calls).toHaveLength(1)
})

it('already applied (sync already reflects the target state): exit 0, "already applied" warning, no push', async () => {
  const calls: any[] = []
  const t1 = fixtureStore().getTransaction('t1')!
  const syncResponse = { serverTimestamp: 1789000050, transaction: [{ ...t1, comment: 'New', changed: 1780000600 }] }
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: apiFetch([syncResponse], calls) })

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: false, expect: undefined, plan: editT1 })
  const token = t.json().data.token
  t.out.length = 0

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: true, expect: token, plan: editT1 })

  expect(calls).toHaveLength(1)
  const out = t.json()
  expect(out.data.applied).toBe(true)
  expect(out.data.applyCommand).toBeNull()
  expect(out.warnings).toContain('already applied')
})

it('a target already in the requested state is dropped from the plan, never blocking the rest', async () => {
  const calls: any[] = []
  // t4 already has the target comment from the very start (as if a
  // previous zm edit, or an app edit, already landed it) - seeded directly
  // in the cache, since a dry-run never syncs.
  const t4Already = { ...fixtureStore().getTransaction('t4')!, comment: 'New' }
  const changed = Math.max(NOW_SEC, T1_CHANGED + 1)
  const pushedT1 = { ...fixtureStore().getTransaction('t1')!, comment: 'New', changed }
  const syncResponse1 = { serverTimestamp: 1789000050 } // nothing new: t1/t4 come from the seeded cache
  const pushResponse = { serverTimestamp: 1789000100, transaction: [pushedT1] }
  const syncResponse2 = { serverTimestamp: 1789000150 } // retry's sync: nothing new either
  const t = seededContext({
    env: { ZENMONEY_TOKEN: 'tok' },
    now: () => NOW,
    fetch: apiFetch([syncResponse1, pushResponse, syncResponse2], calls),
  })
  const seed = Store.open(t.ctx.paths.cacheDb)
  seed.applyDiff({ serverTimestamp: 1789000000, transaction: [t4Already] }, new Date('2026-09-15T08:00:00Z'))
  seed.close()

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', 't4', '--comment', 'New'], apply: false, expect: undefined, plan: editT1AndT4 })
  const dry = t.json()
  expect(dry.warnings).toContain('already in that state: t4')
  expect(dry.data.changes.map((c: any) => c.id)).toEqual(['t1'])
  const token = dry.data.token
  t.out.length = 0

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', 't4', '--comment', 'New'], apply: true, expect: token, plan: editT1AndT4 })
  expect(calls).toHaveLength(2)
  expect(calls[1].transaction).toEqual([expect.objectContaining({ id: 't1' })]) // t4 never sent
  const applied = t.json()
  expect(applied.data.applied).toBe(true)
  expect(applied.data.changes.map((c: any) => c.id)).toEqual(['t1'])
  t.out.length = 0

  // Retry the identical apply command: t1 now matches (from the push
  // response just applied to the cache) and t4 always did -> every target
  // is applied, no second push.
  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', 't4', '--comment', 'New'], apply: true, expect: token, plan: editT1AndT4 })
  expect(calls).toHaveLength(3) // one more sync call, no push
  expect(calls[2].transaction).toBeUndefined()
  const retry = t.json()
  expect(retry.data.applied).toBe(true)
  expect(retry.warnings).toContain('already applied')
})

it('add with an id that already exists with different content exits CONFLICT', async () => {
  const calls: any[] = []
  const uuid = '00000000-0000-4000-8000-00000000000a'
  const addPlan: Planner = (_store, ds) => planAdd(ds, { id: uuid, kind: 'expense', amount: 1, accountId: 'acc-pln', date: '2026-09-20' })
  const t1 = fixtureStore().getTransaction('t1')!
  const conflicting: ZmTransaction = { ...t1, id: uuid, outcome: 999, income: 0 }
  const syncResponse = { serverTimestamp: 1789000050, transaction: [conflicting] }
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: apiFetch([syncResponse], calls) })

  await runWrite(t.ctx, { format: 'json', argv: ['add', '--expense', '1', '--account', 'acc-pln', '--id', uuid], apply: false, expect: undefined, plan: addPlan })
  const token = t.json().data.token
  t.out.length = 0

  await expect(
    runWrite(t.ctx, { format: 'json', argv: ['add', '--expense', '1', '--account', 'acc-pln', '--id', uuid], apply: true, expect: token, plan: addPlan }),
  ).rejects.toMatchObject({ code: 'CONFLICT', message: `transaction ${uuid} already exists with different content` })
  expect(calls).toHaveLength(1)
})

it('delete: push payload has deleted: true', async () => {
  const calls: any[] = []
  const originalT1 = fixtureStore().getTransaction('t1')!
  const deletePlan: Planner = () => planDelete([originalT1])
  const syncResponse = fixtureDiff() // t1 unchanged
  const changed = Math.max(NOW_SEC, T1_CHANGED + 1)
  const pushResponse = { serverTimestamp: 1789000100, transaction: [{ ...originalT1, deleted: true, changed }] }
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: apiFetch([syncResponse, pushResponse], calls) })

  await runWrite(t.ctx, { format: 'json', argv: ['delete', 't1'], apply: false, expect: undefined, plan: deletePlan })
  const token = t.json().data.token
  t.out.length = 0

  await runWrite(t.ctx, { format: 'json', argv: ['delete', 't1'], apply: true, expect: token, plan: deletePlan })

  expect(calls[1].transaction).toEqual([expect.objectContaining({ id: 't1', deleted: true })])
  const out = t.json()
  expect(out.data.applied).toBe(true)
})

it('delete of an id the sync already removed: already applied, no push', async () => {
  const calls: any[] = []
  const originalT1 = fixtureStore().getTransaction('t1')!
  const deletePlan: Planner = () => planDelete([originalT1])
  const syncResponse = { serverTimestamp: 1789000050, deletion: [{ id: 't1', object: 'transaction', stamp: 1789000000, user: 10 }] }
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: apiFetch([syncResponse], calls) })

  await runWrite(t.ctx, { format: 'json', argv: ['delete', 't1'], apply: false, expect: undefined, plan: deletePlan })
  const token = t.json().data.token
  t.out.length = 0

  await runWrite(t.ctx, { format: 'json', argv: ['delete', 't1'], apply: true, expect: token, plan: deletePlan })

  expect(calls).toHaveLength(1)
  const out = t.json()
  expect(out.data.applied).toBe(true)
  expect(out.warnings).toContain('already applied')
})

it('401 on push exits AUTH (3)', async () => {
  const calls: any[] = []
  const syncResponse = fixtureDiff()
  let n = 0
  const fetchFn = (async (_url: string, init: any) => {
    n++
    if (n === 1) {
      calls.push(JSON.parse(init.body))
      return new Response(JSON.stringify(syncResponse), { status: 200 })
    }
    return new Response('unauthorized', { status: 401 })
  }) as unknown as typeof fetch
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: fetchFn })

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: false, expect: undefined, plan: editT1 })
  const token = t.json().data.token
  t.out.length = 0

  await expect(
    runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: true, expect: token, plan: editT1 }),
  ).rejects.toMatchObject({ code: 'AUTH' })
})

it('network failure on push exits NETWORK (4) with the "safe to retry" hint', async () => {
  const syncResponse = fixtureDiff()
  let n = 0
  const fetchFn = (async (_url: string, init: any) => {
    n++
    if (n === 1) return new Response(JSON.stringify(syncResponse), { status: 200 })
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: fetchFn })

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: false, expect: undefined, plan: editT1 })
  const token = t.json().data.token
  t.out.length = 0

  await expect(
    runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: true, expect: token, plan: editT1 }),
  ).rejects.toMatchObject({ code: 'NETWORK', hint: expect.stringContaining('safe to retry') })
})

it('cache write after a successful push fails: still exits 0 with a cache warning', async () => {
  const calls: any[] = []
  const t1 = fixtureStore().getTransaction('t1')!
  const changed = Math.max(NOW_SEC, T1_CHANGED + 1)
  const syncResponse = fixtureDiff()
  const pushResponse = { serverTimestamp: 1789000100, transaction: [{ ...t1, comment: 'New', changed }] }
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: apiFetch([syncResponse, pushResponse], calls) })

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: false, expect: undefined, plan: editT1 })
  const token = t.json().data.token
  t.out.length = 0

  const original = Store.prototype.applyDiff
  let applyDiffCalls = 0
  const spy = vi.spyOn(Store.prototype, 'applyDiff').mockImplementation(function (this: Store, ...args: Parameters<typeof original>) {
    applyDiffCalls++
    if (applyDiffCalls === 1) return original.apply(this, args)
    throw new Error('cache boom')
  })
  try {
    await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: true, expect: token, plan: editT1 })
  } finally {
    spy.mockRestore()
  }

  const out = t.json()
  expect(out.data.applied).toBe(true)
  expect(out.warnings).toContain('written to ZenMoney, but the local cache was not updated: run zm sync')
})

it('a push response missing the impacted account adds a balance warning; one that includes it does not', async () => {
  const uuid = '00000000-0000-4000-8000-00000000000b'
  const addPlan: Planner = (_store, ds) => planAdd(ds, { id: uuid, kind: 'expense', amount: 12.5, accountId: 'acc-pln', date: '2026-09-20' })
  const pushedTx: ZmTransaction = {
    id: uuid, user: 10, date: '2026-09-20', income: 0, outcome: 12.5,
    incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln', incomeInstrument: 100, outcomeInstrument: 100,
    tag: null, merchant: null, payee: null, comment: null, deleted: false, created: NOW_SEC, changed: NOW_SEC,
  }

  {
    const calls: any[] = []
    const syncResponse = fixtureDiff()
    const pushResponse = { serverTimestamp: 1789000100, transaction: [pushedTx] } // no account
    const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: apiFetch([syncResponse, pushResponse], calls) })
    await runWrite(t.ctx, { format: 'json', argv: ['add', '--expense', '12.50', '--account', 'acc-pln', '--id', uuid], apply: false, expect: undefined, plan: addPlan })
    const token = t.json().data.token
    t.out.length = 0
    await runWrite(t.ctx, { format: 'json', argv: ['add', '--expense', '12.50', '--account', 'acc-pln', '--id', uuid], apply: true, expect: token, plan: addPlan })
    expect(t.json().warnings).toContain('account Card PLN: the server response did not include an updated balance; check it in ZenMoney')
    // A create's payload gets `created` overridden to the same
    // skew-guarded value as `changed` (unlike an edit, which keeps the
    // target's original `created` — see the apply-success test above).
    expect(calls[1].transaction[0].created).toBe(calls[1].transaction[0].changed)
  }
  {
    const calls: any[] = []
    const syncResponse = fixtureDiff()
    const pushResponse = {
      serverTimestamp: 1789000100,
      transaction: [pushedTx],
      account: [{ id: 'acc-pln', user: 10, instrument: 100, type: 'ccard', title: 'Card PLN', balance: 49987.5, inBalance: true, archive: false, changed: NOW_SEC }],
    }
    const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: apiFetch([syncResponse, pushResponse], calls) })
    await runWrite(t.ctx, { format: 'json', argv: ['add', '--expense', '12.50', '--account', 'acc-pln', '--id', uuid], apply: false, expect: undefined, plan: addPlan })
    const token = t.json().data.token
    t.out.length = 0
    await runWrite(t.ctx, { format: 'json', argv: ['add', '--expense', '12.50', '--account', 'acc-pln', '--id', uuid], apply: true, expect: token, plan: addPlan })
    expect(t.json().warnings ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining('did not include an updated balance')]))
  }
})

it('a push response missing the written transaction adds an echo warning; one that includes it does not', async () => {
  const syncResponse = fixtureDiff()

  {
    const calls: any[] = []
    const pushResponse = { serverTimestamp: 1789000100 } // no `transaction` key at all, let alone an echo of t1
    const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: apiFetch([syncResponse, pushResponse], calls) })
    await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: false, expect: undefined, plan: editT1 })
    const token = t.json().data.token
    t.out.length = 0
    await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: true, expect: token, plan: editT1 })
    expect(t.json().warnings).toContain(
      'transaction t1: the server response did not echo this write; run zm sync --full to be sure the local cache matches ZenMoney',
    )
  }
  {
    const calls: any[] = []
    const changed = Math.max(NOW_SEC, T1_CHANGED + 1)
    const pushedT1 = { ...fixtureStore().getTransaction('t1')!, comment: 'New', changed }
    const pushResponse = { serverTimestamp: 1789000100, transaction: [pushedT1] }
    const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: apiFetch([syncResponse, pushResponse], calls) })
    await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: false, expect: undefined, plan: editT1 })
    const token = t.json().data.token
    t.out.length = 0
    await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: true, expect: token, plan: editT1 })
    expect(t.json().warnings ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining('did not echo this write')]))
  }
})

it('400 on push exits NETWORK with the "ZenMoney rejected the write" hint (nothing changed)', async () => {
  const syncResponse = fixtureDiff()
  let n = 0
  const fetchFn = (async (_url: string, init: any) => {
    n++
    if (n === 1) return new Response(JSON.stringify(syncResponse), { status: 200 })
    return new Response('bad request', { status: 400 })
  }) as unknown as typeof fetch
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: fetchFn })

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: false, expect: undefined, plan: editT1 })
  const token = t.json().data.token
  t.out.length = 0

  await expect(
    runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: true, expect: token, plan: editT1 }),
  ).rejects.toMatchObject({
    code: 'NETWORK',
    hint: 'ZenMoney rejected the write; nothing was changed. Rerun without --apply to review the plan',
  })
})

it('503 on push exits NETWORK with the "safe to retry" hint', async () => {
  const syncResponse = fixtureDiff()
  let n = 0
  const fetchFn = (async (_url: string, init: any) => {
    n++
    if (n === 1) return new Response(JSON.stringify(syncResponse), { status: 200 })
    return new Response('unavailable', { status: 503 })
  }) as unknown as typeof fetch
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: fetchFn })

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: false, expect: undefined, plan: editT1 })
  const token = t.json().data.token
  t.out.length = 0

  await expect(
    runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: true, expect: token, plan: editT1 }),
  ).rejects.toMatchObject({ code: 'NETWORK', hint: expect.stringContaining('safe to retry') })
})

it('malformed push response ("invalid response from ZenMoney") exits NETWORK with the "safe to retry" hint', async () => {
  const syncResponse = fixtureDiff()
  let n = 0
  const fetchFn = (async (_url: string, init: any) => {
    n++
    if (n === 1) return new Response(JSON.stringify(syncResponse), { status: 200 })
    return new Response(JSON.stringify({ no: 'serverTimestamp here' }), { status: 200 })
  }) as unknown as typeof fetch
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => NOW, fetch: fetchFn })

  await runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: false, expect: undefined, plan: editT1 })
  const token = t.json().data.token
  t.out.length = 0

  await expect(
    runWrite(t.ctx, { format: 'json', argv: ['edit', 't1', '--comment', 'New'], apply: true, expect: token, plan: editT1 }),
  ).rejects.toMatchObject({ code: 'NETWORK', hint: expect.stringContaining('safe to retry') })
})
