import { it, expect } from 'vitest'
import { loadDataset, type Dataset } from '../../src/query/model.js'
import { applyFilters, resolveAccount, resolveCategory, resolveOwner, resolvePeriod } from '../../src/query/filters.js'
import type { ZmAccount } from '../../src/api/types.js'
import { fixtureStore } from '../helpers.js'

const ds = loadDataset(fixtureStore())
const ids = (f: any) => applyFilters(ds, f).map(t => t.id).sort()

// Minimal Dataset for resolveAccount cases that need titles chosen specifically
// to exercise exact-vs-substring priority; the fixture's account titles don't
// happen to overlap that way.
function accountDataset(accounts: ZmAccount[]): Dataset {
  return { users: ds.users, accounts: new Map(accounts.map(a => [a.id, a])), tags: ds.tags, instruments: ds.instruments, txs: [] }
}
function account(id: string, title: string): ZmAccount {
  return { id, user: 10, instrument: 100, type: 'cash', title, balance: 0, inBalance: true, archive: false, changed: 0 }
}

it('period', () => {
  expect(resolvePeriod({ month: '2026-09' })).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  expect(() => resolvePeriod({ month: '2026-09', from: '2026-09-01' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  expect(() => resolvePeriod({ from: '09/01/2026' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  expect(ids({ from: '2026-09-10', to: '2026-09-12' })).toEqual(['t4', 't5'])
})
it('period rejects impossible calendar dates and months', () => {
  expect(() => resolvePeriod({ from: '2026-02-30' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  expect(() => resolvePeriod({ from: '2026-13-45' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  expect(() => resolvePeriod({ month: '2026-13' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
it('period rejects from after to', () => {
  expect(() => resolvePeriod({ from: '2026-09-12', to: '2026-09-10' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
it('category includes children and matches by leaf title', () => {
  expect(ids({ month: '2026-09', category: 'здоровье' })).toEqual(['t19', 't4'])
  expect(resolveCategory(ds, 'Стоматология').path).toBe('Здоровье/Стоматология')
  expect(resolveCategory(ds, 'Еда/Кафе').id).toBe('cafe')
})
it('resolveCategory: duplicate full-path match is ambiguous', () => {
  const dupTags = new Map(ds.tags)
  dupTags.set('food2', { id: 'food2', user: 10, title: 'Продукты', parent: null, showIncome: false, showOutcome: true, changed: 0 })
  const dupDs: Dataset = { users: ds.users, accounts: ds.accounts, tags: dupTags, instruments: ds.instruments, txs: [] }
  try { resolveCategory(dupDs, 'Продукты'); throw new Error('no throw') }
  catch (e: any) {
    expect(e.code).toBe('INVALID_ARGS')
    expect(e.hint).toMatch(/Продукты \(food\)/)
    expect(e.hint).toMatch(/Продукты \(food2\)/)
  }
})
it('unknown category suggests', () => {
  try { resolveCategory(ds, 'Продукт'); throw new Error('no throw') }
  catch (e: any) { expect(e.code).toBe('INVALID_ARGS'); expect(e.hint).toMatch(/Продукты/) }
})
it('owner', () => {
  expect(resolveOwner(ds, 'all')).toBeNull()
  expect([...resolveOwner(ds, 'me')!]).toEqual([10])
  expect([...resolveOwner(ds, 'partner')!]).toEqual([11])
  expect([...resolveOwner(ds, '11')!]).toEqual([11])
  expect(() => resolveOwner(ds, 'bob')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  expect(ids({ month: '2026-09', owner: 'partner' })).toEqual(['t2'])
})
it('account matches either side, currency, type, search', () => {
  expect(ids({ month: '2026-09', account: 'Card PLN', type: ['transfer'] })).toEqual(['t7'])
  expect(ids({ month: '2026-09', currency: 'eur', type: ['expense'] })).toEqual(['t10', 't14', 't3'])
  expect(ids({ search: 'netflix' })).toEqual(['t11', 't12', 't13', 't14'])
})
it('search matches payee even when the tx also has a resolved merchant', () => {
  const dsWithPayee: Dataset = {
    ...ds,
    txs: [
      { ...ds.txs[0]!, id: 'p1', merchant: 'FreshMart', payee: 'Distinct Payee Text' },
    ],
  }
  expect(applyFilters(dsWithPayee, { search: 'distinct payee' }).map(t => t.id)).toEqual(['p1'])
})
it('resolveAccount: exact title match wins over substring match', () => {
  // "Cash" is a substring of both titles, but exactly equals the first one.
  const small = accountDataset([account('a1', 'Cash'), account('a2', 'Cash Wallet')])
  expect(resolveAccount(small, 'Cash').id).toBe('a1')
  expect(resolveAccount(small, 'cash').id).toBe('a1') // case-insensitive
})
it('resolveAccount: ambiguous hint lists title (id) pairs', () => {
  const small = accountDataset([account('a1', 'Blue Wallet'), account('a2', 'Green Wallet')])
  try { resolveAccount(small, 'wallet'); throw new Error('no throw') }
  catch (e: any) {
    expect(e.code).toBe('INVALID_ARGS')
    expect(e.hint).toMatch(/Blue Wallet \(a1\)/)
    expect(e.hint).toMatch(/Green Wallet \(a2\)/)
  }
})
it('resolveAccount: no-match hint lists title (id) pairs', () => {
  const small = accountDataset([account('a1', 'Blue Wallet')])
  try { resolveAccount(small, 'Wallett'); throw new Error('no throw') }
  catch (e: any) {
    expect(e.code).toBe('INVALID_ARGS')
    expect(e.hint).toMatch(/Blue Wallet \(a1\)/)
  }
})
