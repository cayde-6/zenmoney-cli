import { it, expect } from 'vitest'
import { loadDataset, type Dataset } from '../../src/query/model.js'
import { applyFilters, resolveAccount, resolveCategory, resolveFilterRefs, resolveOwner, resolveOwnerName, resolvePeriod, usedCurrencies } from '../../src/query/filters.js'
import { parseOwnersFile } from '../../src/query/owners.js'
import type { ZmAccount } from '../../src/api/types.js'
import { fixtureStore } from '../helpers.js'

const ds = loadDataset(fixtureStore())
const ids = (f: any) => applyFilters(ds, f).map(t => t.id).sort()

// Minimal Dataset for resolveAccount cases that need titles chosen specifically
// to exercise exact-vs-substring priority; the fixture's account titles don't
// happen to overlap that way.
function accountDataset(accounts: ZmAccount[]): Dataset {
  return { users: ds.users, accounts: new Map(accounts.map(a => [a.id, a])), tags: ds.tags, instruments: ds.instruments, txs: [], ownerNames: null, ownerOf: new Map(), ownersPath: null, ownerWarnings: [] }
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
  expect(ids({ month: '2026-09', category: 'health' })).toEqual(['t19', 't4'])
  expect(resolveCategory(ds, 'Dentist').path).toBe('Health/Dentist')
  expect(resolveCategory(ds, 'Food/Cafe').id).toBe('cafe')
})
it('resolveCategory: duplicate full-path match is ambiguous', () => {
  const dupTags = new Map(ds.tags)
  dupTags.set('food2', { id: 'food2', user: 10, title: 'Groceries', parent: null, showIncome: false, showOutcome: true, changed: 0 })
  const dupDs: Dataset = { users: ds.users, accounts: ds.accounts, tags: dupTags, instruments: ds.instruments, txs: [], ownerNames: null, ownerOf: new Map(), ownersPath: null, ownerWarnings: [] }
  try { resolveCategory(dupDs, 'Groceries'); throw new Error('no throw') }
  catch (e: any) {
    expect(e.code).toBe('INVALID_ARGS')
    expect(e.hint).toMatch(/Groceries \(food\)/)
    expect(e.hint).toMatch(/Groceries \(food2\)/)
  }
})
it('unknown category suggests', () => {
  try { resolveCategory(ds, 'Grocerie'); throw new Error('no throw') }
  catch (e: any) { expect(e.code).toBe('INVALID_ARGS'); expect(e.hint).toMatch(/Groceries/) }
})
// A-17: a category title that itself contains "/" (e.g. "Phone/Internet")
// must resolve both by its full path and by its bare (unsplit) leaf title —
// splitting the joined path on "/" to find "the leaf" would instead extract
// "Internet" and fail to match the query at all.
it('resolves a category whose own title contains "/", both by full path and by its unsplit leaf title', () => {
  const tags = new Map(ds.tags)
  tags.set('services', { id: 'services', user: 10, title: 'Services', parent: null, showIncome: false, showOutcome: true, changed: 0 })
  tags.set('phone-internet', { id: 'phone-internet', user: 10, title: 'Phone/Internet', parent: 'services', showIncome: false, showOutcome: true, changed: 0 })
  const withServices: Dataset = { ...ds, tags }
  expect(resolveCategory(withServices, 'Services/Phone/Internet').id).toBe('phone-internet')
  expect(resolveCategory(withServices, 'Phone/Internet').id).toBe('phone-internet')
})
it('owner', () => {
  expect(resolveOwner(ds, 'all')).toBeNull()
  expect([...resolveOwner(ds, 'me')!]).toEqual([10])
  expect([...resolveOwner(ds, 'partner')!]).toEqual([11])
  expect([...resolveOwner(ds, '11')!]).toEqual([11])
  expect(() => resolveOwner(ds, 'bob')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  expect(ids({ month: '2026-09', owner: 'partner' })).toEqual(['t2'])
})
it('resolveOwnerName: all (default), unassigned, a known name, and an unknown name with a full-list hint', () => {
  expect(resolveOwnerName(['alex', 'sam'], 'owners.yaml', undefined)).toBe('all')
  expect(resolveOwnerName(['alex', 'sam'], 'owners.yaml', 'all')).toBe('all')
  expect(resolveOwnerName(['alex', 'sam'], 'owners.yaml', 'unassigned')).toBe('unassigned')
  expect(resolveOwnerName(['alex', 'sam'], 'owners.yaml', 'alex')).toBe('alex')
  // Review round item 4: the hint lists every defined name (not just the
  // top-3 closest by edit distance, unlike category/account's did-you-mean),
  // names the file's path, and lists 'all'/'unassigned' as always accepted.
  try { resolveOwnerName(['alex', 'sam'], '/home/x/.config/zm/owners.yaml', 'ale'); throw new Error('no throw') }
  catch (e: any) {
    expect(e.code).toBe('INVALID_ARGS')
    expect(e.message).toBe('unknown owner: ale')
    expect(e.hint).toBe('owners.yaml (/home/x/.config/zm/owners.yaml) defines: alex, sam; also accepted: all, unassigned')
  }
})
// Review round item 7: --owner is compared case-insensitively against file
// owner names, but the returned/stored value is always the file's own
// spelling (so Tx.owner/accounts.owner never show a caller's casing).
it('resolveOwnerName matches case-insensitively but returns the file\'s own spelling', () => {
  expect(resolveOwnerName(['Alex', 'sam'], 'owners.yaml', 'alex')).toBe('Alex')
  expect(resolveOwnerName(['Alex', 'sam'], 'owners.yaml', 'ALEX')).toBe('Alex')
  expect(resolveOwnerName(['Alex', 'sam'], 'owners.yaml', 'SAM')).toBe('sam')
})
it('resolveOwnerName hint says so when owners.yaml defines no owners at all', () => {
  try { resolveOwnerName([], '/x/owners.yaml', 'alex'); throw new Error('no throw') }
  catch (e: any) {
    expect(e.hint).toBe('owners.yaml (/x/owners.yaml) defines no owners; also accepted: all, unassigned')
  }
})
// Once owners.yaml exists, --owner switches from ZenMoney-user semantics
// (me/login/id) to name/unassigned/all semantics, driven by Tx.owner rather
// than Tx.ownerId — acc-pln -> alex, acc-partner -> sam, everything else
// (e.g. acc-eur) unassigned.
it('applyFilters uses owner names instead of ZenMoney users once owners.yaml exists', () => {
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["Card PLN"]\n  sam:\n    accounts: ["acc-partner"]\n', 'owners.yaml')
  const dsWithOwners = loadDataset(fixtureStore(), file)
  const idsWithOwners = (f: any) => applyFilters(dsWithOwners, f).map(t => t.id).sort()

  expect(idsWithOwners({ month: '2026-09', owner: 'alex' })).toEqual(idsWithOwners({ month: '2026-09' }).filter(id =>
    dsWithOwners.txs.find(t => t.id === id)!.owner === 'alex',
  ))
  expect(idsWithOwners({ month: '2026-09', owner: 'sam' })).toEqual(['t2'])
  expect(idsWithOwners({ month: '2026-09', owner: 'unassigned' }).every(id =>
    dsWithOwners.txs.find(t => t.id === id)!.owner === null,
  )).toBe(true)
  expect(idsWithOwners({ month: '2026-09', owner: 'unassigned' }).length).toBeGreaterThan(0)
  // Old ZenMoney-user semantics no longer apply: 'me' isn't a valid owner
  // name in this file, so it's rejected exactly like any other unknown name.
  expect(() => applyFilters(dsWithOwners, { owner: 'me' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
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
// A-21: resolving category/account once per command, not once for meta and
// again inside applyFilters.
it('applyFilters uses pre-resolved refs instead of re-resolving from filters.category/account', () => {
  const refs = { categoryPath: 'Groceries', categoryIds: new Set(['food']), accountId: 'acc-pln' }
  // `category`/`account` here would themselves fail to resolve (ambiguous
  // leaf title collision) if applyFilters actually re-resolved them —
  // passing `refs` must make it skip that entirely and just use them.
  const result = applyFilters(ds, { category: 'this is not a real category at all', account: 'nope', month: '2026-09' }, refs)
  expect(result.every(t => t.categoryId === 'food')).toBe(true)
})
it('resolveFilterRefs resolves category/account once, reusable across multiple applyFilters calls', () => {
  const refs = resolveFilterRefs(ds, { category: 'Groceries', account: 'Card PLN' })
  expect(refs.categoryPath).toBe('Groceries')
  expect(refs.accountId).toBe('acc-pln')
  expect([...refs.categoryIds!]).toEqual(['food'])
})
// A-21: one shared used-currency helper, reused by currencyWarnings and by
// `zm rates` (see tests/cli/reference.test.ts for the `rates` behavior).
it('usedCurrencies includes every account currency plus both sides of every transaction', () => {
  const used = usedCurrencies(ds)
  expect(used.has('PLN')).toBe(true)
  expect(used.has('EUR')).toBe(true)
})
it('resolveAccount: no-match hint lists title (id) pairs', () => {
  const small = accountDataset([account('a1', 'Blue Wallet')])
  try { resolveAccount(small, 'Wallett'); throw new Error('no throw') }
  catch (e: any) {
    expect(e.code).toBe('INVALID_ARGS')
    expect(e.hint).toMatch(/Blue Wallet \(a1\)/)
  }
})
