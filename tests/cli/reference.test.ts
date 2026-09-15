import { it, expect } from 'vitest'
import { run } from '../../src/cli/program.js'
import { seededContext, testContext } from '../helpers.js'
import { Store } from '../../src/store/store.js'
import { fixtureDiff } from '../fixtures/diff.js'
import type { ZmTransaction } from '../../src/api/types.js'

const zm = async (args: string[], over = {}) => { const t = seededContext(over); const code = await run(['node', 'zm', ...args], t.ctx); return { code, t } }

it('users', async () => {
  const { code, t } = await zm(['users'])
  expect(code).toBe(0)
  expect(t.json().data).toEqual([
    { id: 10, login: 'owner', currency: 'EUR', isMain: true },
    { id: 11, login: 'partner', currency: 'EUR', isMain: false },
  ])
  expect(t.json().meta.lastSyncAt).toBe('2026-09-15T08:00:00.000Z')
})
it('users --owner filters to the matching user', async () => {
  const { code, t } = await zm(['users', '--owner', 'partner'])
  expect(code).toBe(0)
  expect(t.json().data).toEqual([{ id: 11, login: 'partner', currency: 'EUR', isMain: false }])
})
it('categories rejects a non-all --owner', async () => {
  const { code, t } = await zm(['categories', '--owner', 'me'])
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--owner is not supported by categories' })
})
it('rates rejects a non-all --owner', async () => {
  const { code, t } = await zm(['rates', '--owner', 'partner'])
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--owner is not supported by rates' })
})
it('accounts hides archived by default', async () => {
  const { t } = await zm(['accounts'])
  expect(t.json().data.map((a: any) => a.title)).not.toContain('Old Cash')
  expect(t.json().data.find((a: any) => a.id === 'acc-partner')).toEqual({ id: 'acc-partner', title: 'Card Partner', type: 'ccard', currency: 'PLN', balance: 90000, inBalance: true, archived: false, owner: 'partner' })
  const all = await zm(['accounts', '--archived'])
  expect(all.t.json().data).toHaveLength(5)
})
it('accounts respects --owner', async () => {
  const { t } = await zm(['accounts', '--owner', 'partner'])
  expect(t.json().data.map((a: any) => a.id)).toEqual(['acc-partner'])
})
it('categories flat and tree', async () => {
  const flat = (await zm(['categories'])).t.json().data
  expect(flat).toContainEqual({ id: 'cafe', path: 'Еда/Кафе', parentId: 'eat', kind: 'expense' })
  expect(flat).toContainEqual({ id: 'salary', path: 'Зарплата', parentId: null, kind: 'income' })
  const tree = (await zm(['categories', '--tree'])).t.json().data
  expect(tree.find((c: any) => c.id === 'health').children.map((c: any) => c.id)).toEqual(['dent'])
})
it('categories --tree treats a tag with a missing (dangling) parent id as top-level', async () => {
  const t = testContext()
  const store = Store.open(t.ctx.paths.cacheDb)
  const diff = fixtureDiff()
  diff.tag!.push({ id: 'orphan', user: 10, title: 'Orphan', parent: 'no-such-tag', showIncome: false, showOutcome: true, changed: 1780000000 })
  store.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  store.close()
  const code = await run(['node', 'zm', 'categories', '--tree'], t.ctx)
  expect(code).toBe(0)
  expect(t.json().data.some((c: any) => c.id === 'orphan')).toBe(true)
})
it('categories --tree table flattens children with a two-space indent, never falling back to JSON', async () => {
  const { t } = await zm(['categories', '--tree', '--format', 'table'])
  const out = t.out.join('')
  expect(out).not.toMatch(/^\s*\[/) // not a raw JSON array dump
  // The id column is padded to width 6 (the longest id, "health"/"salary"), then
  // joined with a literal 2-space separator: that's 4 spaces of natural padding
  // after "dent" (4 chars) before the path column even starts. The child row's
  // indent must add exactly 2 more, for exactly 6 total — anchored at line start
  // so padding can't be mistaken for the indent (a loose `\s+` match, which
  // backtracks to fit any number of spaces, would pass even without one).
  expect(out).toMatch(/^dent {6}Здоровье\/Стоматология/m)
})
it('tx table flattens counterpart into counterpartAccount/Amount/Currency columns', async () => {
  const { t } = await zm(['tx', '--month', '2026-09', '--type', 'transfer', '--format', 'table'])
  const out = t.out.join('')
  expect(out).toMatch(/counterpartAccount\s+counterpartAmount\s+counterpartCurrency/)
  expect(out).toMatch(/Card PLN\s+11700\s+PLN/)
})
it('rates relative to main user currency', async () => {
  const { t } = await zm(['rates'])
  expect(t.json().meta.base).toBe('EUR')
  expect(t.json().meta.note).toMatch(/current/)
  expect(t.json().data).toContainEqual({ currency: 'PLN', rate: 0.222222 })
})
it('rates only counts instruments used by non-deleted transactions', async () => {
  const t = testContext()
  const store = Store.open(t.ctx.paths.cacheDb)
  const diff = fixtureDiff()
  const deletedUsdTx: ZmTransaction = {
    id: 'tDelUsd', user: 10, date: '2026-09-01', income: 0, outcome: 5, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 1, outcomeInstrument: 1, tag: null, merchant: null, payee: null, comment: null,
    deleted: true, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(deletedUsdTx)
  store.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  store.close()
  const code = await run(['node', 'zm', 'rates'], t.ctx)
  expect(code).toBe(0)
  expect(t.json().data.map((r: any) => r.currency)).not.toContain('USD')
})
it('tx --type rejects an empty list', async () => {
  const { code, t } = await zm(['tx', '--type', ''])
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
  const commaOnly = await zm(['tx', '--type', ','])
  expect(commaOnly.code).toBe(2)
  expect(commaOnly.t.errJson().error.code).toBe('INVALID_ARGS')
})
it('tx with filters and limit', async () => {
  const { t } = await zm(['tx', '--month', '2026-09', '--type', 'expense,refund', '--category', 'Продукты', '--limit', '2'])
  expect(t.json().data.map((x: any) => x.id)).toEqual(['t5', 't2'])
  expect(t.json().meta).toMatchObject({ from: '2026-09-01', to: '2026-09-30', category: 'Продукты', total: 3, returned: 2 })
})
it('tx warns on an unknown --currency but still succeeds', async () => {
  const { code, t } = await zm(['tx', '--currency', 'ZZZ'])
  expect(code).toBe(0)
  expect(t.json().data).toEqual([])
  expect(t.json().warnings).toContain('unknown currency: ZZZ')
})
it('tx does not warn for a currency that is actually used', async () => {
  const { t } = await zm(['tx', '--currency', 'PLN'])
  expect(t.json().warnings).toBeUndefined()
})
it('tx meta lists every applied filter', async () => {
  const { t } = await zm(['tx', '--month', '2026-09', '--account', 'Card PLN', '--currency', 'PLN', '--type', 'expense,refund', '--search', 'food', '--limit', '5', '--owner', 'me'])
  expect(t.json().meta).toMatchObject({
    from: '2026-09-01', to: '2026-09-30', category: null, owner: 'me',
    account: 'acc-pln', currency: 'PLN', type: ['expense', 'refund'], search: 'food', limit: 5,
  })
})
it('stale cache adds warning', async () => {
  const { t } = await zm(['users'], { now: () => new Date('2026-09-18T09:00:00Z') })
  expect(t.json().warnings).toEqual(['cache is 3 days old, run zm sync'])
})
it('bad category exits 2', async () => {
  const { code, t } = await zm(['tx', '--category', 'Nope'])
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
})
it('no cache exits 5', async () => {
  const t = testContext()
  expect(await run(['node', 'zm', 'users'], t.ctx)).toBe(5)
})
