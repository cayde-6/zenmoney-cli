import { it, expect } from 'vitest'
import { loadDataset } from '../../src/query/model.js'
import type { Tx } from '../../src/query/model.js'
import type { ZmTag, ZmTransaction } from '../../src/api/types.js'
import { applyFilters } from '../../src/query/filters.js'
import { spendBy, incomeBy } from '../../src/analytics/spend.js'
import { fixtureStore } from '../helpers.js'
import { Store } from '../../src/store/store.js'
import { fixtureDiff } from '../fixtures/diff.js'

const ds = loadDataset(fixtureStore())
const sept = applyFilters(ds, { month: '2026-09' })

function tx(over: Partial<Tx>): Tx {
  return {
    id: 'x', date: '2026-09-01', type: 'expense', amount: 10, currency: 'EUR',
    accountId: 'a', accountTitle: 'a', ownerId: 1, categoryId: 'h1', topCategoryId: 'h1',
    categoryPath: 'Health', merchant: null, payee: null, comment: null, hold: false, originalPayee: null, ...over,
  }
}

it('spend by category nets refunds, separates currencies, ignores transfers/debts/income', () => {
  expect(spendBy(sept, 'category')).toEqual([
    { key: 'Food/Cafe', amounts: [{ currency: 'EUR', amount: 20, count: 1 }] },
    { key: 'Groceries', amounts: [{ currency: 'PLN', amount: 4500, count: 3 }] },
    { key: 'Health', amounts: [{ currency: 'PLN', amount: 5000, count: 1 }] },
    { key: 'Health/Dentist', amounts: [{ currency: 'PLN', amount: 80000, count: 1 }] },
    { key: 'Subscriptions', amounts: [{ currency: 'EUR', amount: 12, count: 1 }] },
    { key: 'Uncategorized', amounts: [{ currency: 'EUR', amount: 10, count: 1 }] },
  ])
})
it('tree aggregates children into parent', () => {
  const health = spendBy(sept, 'category', { tree: true, tags: ds.tags }).find(g => g.key === 'Health')!
  expect(health.amounts).toEqual([{ currency: 'PLN', amount: 85000, count: 2 }])
  expect(health.children).toEqual([{ key: 'Health/Dentist', amounts: [{ currency: 'PLN', amount: 80000, count: 1 }] }])
})
it('by month and merchant', () => {
  const food = applyFilters(ds, { category: 'Groceries' })
  expect(spendBy(food, 'month').map(g => [g.key, g.amounts[0]!.amount])).toEqual([['2026-06', 40000], ['2026-07', 50000], ['2026-08', 45000], ['2026-09', 4500]])
  expect(spendBy(sept, 'merchant').find(g => g.key === 'FreshMart')!.amounts).toEqual([{ currency: 'PLN', amount: 2500, count: 2 }])
})
// spend --by merchant must use the same merchant -> payee -> originalPayee ->
// comment fallback as `zm recurring` (fixture txs t20..t23: no merchant, no
// payee, no originalPayee, only a comment), so the two commands agree on what
// a transaction's "merchant" is.
it('by merchant falls back to comment, same as findRecurring', () => {
  const music = applyFilters(ds, { category: 'Music' })
  const group = spendBy(music, 'merchant').find(g => g.key === 'Music Plus')
  expect(group).toBeDefined()
  expect(group!.amounts).toEqual([{ currency: 'PLN', amount: 6000, count: 4 }])
})
it('the (no merchant) bucket only appears when merchant, payee, originalPayee, and comment are all empty', () => {
  const noLabel = { ...ds.txs.find(t => t.categoryPath === 'Music')!, id: 'nl1', merchant: null, payee: null, originalPayee: null, comment: null }
  expect(spendBy([noLabel], 'merchant').map(g => g.key)).toEqual(['(no merchant)'])
})
it('income', () => {
  expect(incomeBy(sept, 'category')).toEqual([{ key: 'Salary', amounts: [{ currency: 'EUR', amount: 4200, count: 1 }] }])
})
it('tree buckets top-level groups by top category id, disambiguating equal titles as "Title (id)"', () => {
  // Two distinct top categories sharing the same title must not merge into one
  // bucket just because grouping used to key on the title text instead of the id.
  const tags = new Map<string, ZmTag>([
    ['h1', { id: 'h1', user: 1, title: 'Health', parent: null, showIncome: false, showOutcome: true, changed: 0 }],
    ['h2', { id: 'h2', user: 1, title: 'Health', parent: null, showIncome: false, showOutcome: true, changed: 0 }],
  ])
  const txs = [
    tx({ id: 'a1', categoryId: 'h1', topCategoryId: 'h1', categoryPath: 'Health', amount: 10 }),
    tx({ id: 'a2', categoryId: 'h2', topCategoryId: 'h2', categoryPath: 'Health', amount: 20 }),
  ]
  const result = spendBy(txs, 'category', { tree: true, tags })
  expect(result.map(g => g.key).sort()).toEqual(['Health (h1)', 'Health (h2)'])
  expect(result.find(g => g.key === 'Health (h1)')!.amounts).toEqual([{ currency: 'EUR', amount: 10, count: 1 }])
})
it('spendBy throws a clear ZmError instead of a TypeError when tree is requested without tags', () => {
  expect(() => spendBy([tx({})], 'category', { tree: true })).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }))
})
it('tree treats a tag with a missing (dangling) parent as its own top-level group', () => {
  // Built through loadDataset/classify (a real Store + fixtureDiff), not a
  // hand-set topCategoryId on a synthetic Tx: this is what actually exercises
  // the topCategoryIdOf fix in src/query/model.ts. Under the old buggy code
  // this transaction's topCategoryId would be the dangling parent id itself
  // (unresolvable to any tag), which treeByCategory falls back to bucketing
  // as NO_CATEGORY ("Uncategorized") — so this test would fail against it.
  const store = Store.memory()
  const diff = fixtureDiff()
  diff.tag!.push({ id: 'orphan', user: 10, title: 'Orphan Category', parent: 'no-such-parent', showIncome: false, showOutcome: true, changed: 0 })
  const orphanTx: ZmTransaction = {
    id: 'tOrphan', user: 10, date: '2026-09-01', income: 0, outcome: 42, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: ['orphan'], merchant: null, payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(orphanTx)
  store.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const ds2 = loadDataset(store)

  const result = spendBy(ds2.txs, 'category', { tree: true, tags: ds2.tags })
  const top = result.find(g => g.key === 'Orphan Category')
  expect(top).toBeDefined()
  expect(top!.amounts).toEqual([{ currency: 'PLN', amount: 42, count: 1 }])
  expect(top!.children).toBeUndefined()
})
