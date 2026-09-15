import { it, expect } from 'vitest'
import { loadDataset, meUser, type Dataset } from '../../src/query/model.js'
import { fixtureStore } from '../helpers.js'
import { Store } from '../../src/store/store.js'
import { fixtureDiff } from '../fixtures/diff.js'
import type { ZmTransaction } from '../../src/api/types.js'

const ds = () => loadDataset(fixtureStore())
const byId = (id: string) => ds().txs.find(t => t.id === id)!

it('excludes deleted', () => { expect(ds().txs.some(t => t.id === 't9')).toBe(false); expect(ds().txs).toHaveLength(18) })
it('classifies all types', () => {
  expect(byId('t1')).toMatchObject({ type: 'expense', amount: 3000, currency: 'PLN', categoryPath: 'Продукты', merchant: 'FreshMart', ownerId: 10 })
  expect(byId('t2')).toMatchObject({ type: 'expense', ownerId: 11, merchant: 'CornerShop' })
  expect(byId('t2')).toMatchObject({ payee: 'CornerShop' }) // payee-only tx: merchant falls back to payee
  expect(byId('t3')).toMatchObject({ categoryPath: 'Еда/Кафе', topCategoryId: 'eat', currency: 'EUR' })
  expect(byId('t5')).toMatchObject({ type: 'refund', amount: 500, currency: 'PLN' })
  expect(byId('t6')).toMatchObject({ type: 'income', amount: 4200, currency: 'EUR' })
  expect(byId('t7')).toMatchObject({ type: 'transfer', amount: 100, currency: 'EUR', accountId: 'acc-eur', counterpart: { accountId: 'acc-pln', amount: 11700, currency: 'PLN', accountTitle: 'Card PLN' } })
  expect(byId('t8')).toMatchObject({ type: 'debt', amount: 50, currency: 'EUR', accountId: 'acc-eur', counterpart: { accountId: 'acc-debt' } })
  expect(byId('t10')).toMatchObject({ type: 'expense', categoryPath: 'Без категории', categoryId: null })
})
it('sorts by date desc', () => { expect(ds().txs[0]!.id).toBe('t14') })
it('finds me', () => { expect(meUser(ds()).login).toBe('owner') })
it('normalises a whitespace-only comment to null', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const whitespaceComment: ZmTransaction = {
    id: 'tWS', user: 10, date: '2026-09-01', income: 0, outcome: 5, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: null, merchant: null, payee: null, comment: '   ',
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(whitespaceComment)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  expect(loadDataset(s).txs.find(t => t.id === 'tWS')!.comment).toBeNull()
})
it('keeps payee alongside a resolved merchant, rather than dropping it', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const both: ZmTransaction = {
    id: 'tBoth', user: 10, date: '2026-09-01', income: 0, outcome: 5, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: null, merchant: 'm-fresh', payee: 'Distinct Payee', comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(both)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const tx = loadDataset(s).txs.find(t => t.id === 'tBoth')!
  expect(tx.merchant).toBe('FreshMart')
  expect(tx.payee).toBe('Distinct Payee')
})
it('excludes a transaction with income === 0 and outcome === 0 (carries no money)', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const zeroTx: ZmTransaction = {
    id: 'tZero', user: 10, date: '2026-09-01', income: 0, outcome: 0, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: null, merchant: null, payee: null, comment: 'placeholder',
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(zeroTx)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  expect(loadDataset(s).txs.some(t => t.id === 'tZero')).toBe(false)
})
it('a tag whose parent id is missing from the tag map is treated as top-level', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  diff.tag!.push({ id: 'orphan', user: 10, title: 'Orphan Category', parent: 'no-such-parent', showIncome: false, showOutcome: true, changed: 0 })
  const orphanTx: ZmTransaction = {
    id: 'tOrphan', user: 10, date: '2026-09-01', income: 0, outcome: 42, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: ['orphan'], merchant: null, payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(orphanTx)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const tx = loadDataset(s).txs.find(t => t.id === 'tOrphan')!
  // Consistent with categoryPath (and `categories --tree`), a dangling parent
  // reference falls back to the tag's own id/title rather than the unresolved
  // parent id leaking through as topCategoryId.
  expect(tx.topCategoryId).toBe('orphan')
  expect(tx.categoryPath).toBe('Orphan Category')
})
it('meUser throws NO_CACHE when the dataset has no main user', () => {
  const noMainUser: Dataset = {
    users: [{ id: 1, login: 'x', currency: 3, parent: 99, changed: 0 }],
    accounts: new Map(), tags: new Map(), instruments: new Map(), txs: [],
  }
  expect(() => meUser(noMainUser)).toThrow(expect.objectContaining({ code: 'NO_CACHE' }))
})
