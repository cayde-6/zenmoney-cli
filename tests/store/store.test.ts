import { it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store/store.js'
import { fixtureDiff } from '../fixtures/diff.js'

it('applies a full diff', () => {
  const s = Store.memory()
  const stats = s.applyDiff(fixtureDiff(), new Date('2026-09-15T08:00:00Z'))
  expect(stats.upserted.transaction).toBe(19)
  expect(s.all('account')).toHaveLength(5)
  expect(s.all('transaction').find(t => t.id === 't1')?.outcome).toBe(3000)
  expect(s.getMeta()).toEqual({ serverTimestamp: 1789000000, lastSyncAt: '2026-09-15T08:00:00.000Z' })
  expect(s.hasData()).toBe(true)
})

it('upserts changed entities and applies deletions', () => {
  const s = Store.memory()
  s.applyDiff(fixtureDiff(), new Date('2026-09-15T08:00:00Z'))
  const t1 = s.all('transaction').find(t => t.id === 't1')!
  const stats = s.applyDiff({
    serverTimestamp: 1789000500,
    transaction: [{ ...t1, outcome: 3500 }],
    deletion: [{ id: 't2', object: 'transaction', stamp: 1789000400, user: 10 }, { id: 'x', object: 'reminder', stamp: 1, user: 10 }],
  }, new Date('2026-09-16T08:00:00Z'))
  expect(stats).toEqual({ upserted: { transaction: 1 }, deleted: 1 })
  expect(s.all('transaction').find(t => t.id === 't1')?.outcome).toBe(3500)
  expect(s.all('transaction').some(t => t.id === 't2')).toBe(false)
  expect(s.getMeta().serverTimestamp).toBe(1789000500)
})

it('keeps unknown fields in raw json', () => {
  const s = Store.memory()
  const d = fixtureDiff()
  ;(d.account![0] as any).newField = 42
  s.applyDiff(d, new Date())
  expect((s.all('account').find(a => a.id === 'acc-pln') as any).newField).toBe(42)
})

it('returns entities in deterministic id order, stable across upserts', () => {
  const s = Store.memory()
  s.applyDiff(fixtureDiff(), new Date('2026-09-15T08:00:00Z'))
  expect(s.all('account').map(a => a.id)).toEqual(['acc-debt', 'acc-eur', 'acc-old', 'acc-partner', 'acc-pln'])
  const pln = s.all('account').find(a => a.id === 'acc-pln')!
  s.applyDiff({ serverTimestamp: 1789000600, account: [{ ...pln, balance: 12345 }] }, new Date('2026-09-16T08:00:00Z'))
  expect(s.all('account').map(a => a.id)).toEqual(['acc-debt', 'acc-eur', 'acc-old', 'acc-partner', 'acc-pln'])
})

it('applyDiff throws and leaves the store unchanged when an entity cannot be serialized', () => {
  const s = Store.memory()
  const d = fixtureDiff()
  ;(d.account![0] as any).bad = 1n // BigInt is not JSON-serializable
  expect(() => s.applyDiff(d, new Date())).toThrow()
  expect(s.hasData()).toBe(false)
  expect(s.getMeta()).toEqual({ serverTimestamp: 0, lastSyncAt: null })
})

it('applyDiff with reset:true removes rows absent from the new diff, in one transaction', () => {
  const s = Store.memory()
  s.applyDiff(fixtureDiff(), new Date('2026-09-15T08:00:00Z'))
  expect(s.all('transaction').length).toBe(19)
  const stats = s.applyDiff(
    { serverTimestamp: 999, user: [{ id: 10, login: 'owner', currency: 3, parent: null, changed: 1 }] },
    new Date('2026-09-16T00:00:00Z'),
    { reset: true },
  )
  expect(stats.upserted).toEqual({ user: 1 })
  expect(s.all('transaction')).toEqual([])
  expect(s.all('account')).toEqual([])
  expect(s.all('user')).toEqual([{ id: 10, login: 'owner', currency: 3, parent: null, changed: 1 }])
  expect(s.getMeta()).toEqual({ serverTimestamp: 999, lastSyncAt: '2026-09-16T00:00:00.000Z' })
})

it('upserted count reflects distinct ids, even when the same id appears twice in one diff', () => {
  const s = Store.memory()
  const stats = s.applyDiff({
    serverTimestamp: 1,
    account: [
      { id: 'a1', user: 10, instrument: 1, type: 'cash', title: 'A', balance: 0, inBalance: true, archive: false, changed: 1 },
      { id: 'a1', user: 10, instrument: 1, type: 'cash', title: 'A updated', balance: 5, inBalance: true, archive: false, changed: 2 },
    ],
  }, new Date())
  expect(stats.upserted).toEqual({ account: 1 })
  expect(s.all('account')).toHaveLength(1)
  expect(s.all('account')[0]!.title).toBe('A updated')
})

it('reset clears data and meta', () => {
  const s = Store.memory()
  s.applyDiff(fixtureDiff(), new Date())
  s.reset()
  expect(s.hasData()).toBe(false)
  expect(s.getMeta()).toEqual({ serverTimestamp: 0, lastSyncAt: null })
})

it('open creates the file and parent dirs', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'zm-')), 'nested', 'zm.sqlite')
  const s = Store.open(file)
  s.close()
  expect(existsSync(file)).toBe(true)
})

it('persists data across close and reopen of the same file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'zm-')), 'zm.sqlite')
  const s1 = Store.open(file)
  s1.applyDiff(fixtureDiff(), new Date('2026-09-15T08:00:00Z'))
  s1.close()

  const s2 = Store.open(file)
  expect(s2.all('account')).toHaveLength(5)
  expect(s2.all('transaction').find(t => t.id === 't1')?.outcome).toBe(3000)
  expect(s2.getMeta()).toEqual({ serverTimestamp: 1789000000, lastSyncAt: '2026-09-15T08:00:00.000Z' })
  s2.close()
})
