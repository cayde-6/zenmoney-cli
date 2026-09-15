import { it, expect } from 'vitest'
import type { Tx } from '../../src/query/model.js'
import { loadDataset } from '../../src/query/model.js'
import { applyFilters } from '../../src/query/filters.js'
import { budgetStatus, monthElapsedPct, unresolvedLimits } from '../../src/budget/status.js'
import { fixtureStore } from '../helpers.js'

const ds = loadDataset(fixtureStore())
const now = new Date('2026-09-15T12:00:00')

it('month elapsed', () => {
  expect(monthElapsedPct('2026-09', now)).toBe(50)
  expect(monthElapsedPct('2026-08', now)).toBe(100)
  expect(monthElapsedPct('2026-10', now)).toBe(0)
})
it('plan vs fact with child limit taking precedence over parent', () => {
  const limits = new Map([
    ['Groceries', { amount: 10000, currency: 'PLN' }],
    ['Health', { amount: 8000, currency: 'PLN' }],
    ['Health/Dentist', { amount: 100000, currency: 'PLN' }],
    ['Food', { amount: 15, currency: 'PLN' }],
  ])
  const st = budgetStatus(ds, limits, applyFilters(ds, { month: '2026-09' }), '2026-09', now)
  expect(st.monthElapsedPct).toBe(50)
  expect(st.rows).toEqual([
    { category: 'Food', categoryId: 'eat', currency: 'PLN', planned: 15, spent: 0, spentOtherCurrencies: [{ currency: 'EUR', amount: 20 }], remaining: 15, usedPct: 0, monthElapsedPct: 50, pace: -50 },
    { category: 'Groceries', categoryId: 'food', currency: 'PLN', planned: 10000, spent: 4500, spentOtherCurrencies: [], remaining: 5500, usedPct: 45, monthElapsedPct: 50, pace: -5 },
    { category: 'Health', categoryId: 'health', currency: 'PLN', planned: 8000, spent: 5000, spentOtherCurrencies: [], remaining: 3000, usedPct: 62.5, monthElapsedPct: 50, pace: 12.5 },
    { category: 'Health/Dentist', categoryId: 'dent', currency: 'PLN', planned: 100000, spent: 80000, spentOtherCurrencies: [], remaining: 20000, usedPct: 80, monthElapsedPct: 50, pace: 30 },
  ])
  expect(st.unplanned.map(g => g.key)).toEqual(['Subscriptions', 'Uncategorized'])
})
it('unknown limit category fails with suggestion', () => {
  expect(() => budgetStatus(ds, new Map([['Grocerie', { amount: 1, currency: 'PLN' }]]), [], '2026-09', now))
    .toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
it('two limit keys resolving to the same category fail, even written differently', () => {
  const limits = new Map([
    ['Cafe', { amount: 100, currency: 'PLN' }],
    ['Food/Cafe', { amount: 200, currency: 'PLN' }],
  ])
  expect(() => budgetStatus(ds, limits, [], '2026-09', now)).toThrow(/same category/)
  expect(() => budgetStatus(ds, limits, [], '2026-09', now)).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
it('unresolvedLimits skips a key that no longer resolves, warning and reporting it', () => {
  const limits = new Map([
    ['Groceries', { amount: 10000, currency: 'PLN' }],
    ['NoSuchCategoryAnymore', { amount: 500, currency: 'EUR' }],
  ])
  const keySources = new Map([['Groceries', 'default.yaml'], ['NoSuchCategoryAnymore', 'default.yaml']])
  const { resolvable, unresolved, warnings } = unresolvedLimits(ds, limits, keySources)
  expect([...resolvable.keys()]).toEqual(['Groceries'])
  expect(unresolved).toEqual([{ key: 'NoSuchCategoryAnymore', amount: 500, currency: 'EUR' }])
  expect(warnings).toEqual(['unknown budget category "NoSuchCategoryAnymore" in default.yaml, skipped'])
})
it('unresolvedLimits still throws for an ambiguous key, rather than skipping it', () => {
  // Two distinct leaf tags sharing a title, under different parents: querying
  // the bare leaf title matches neither full path exactly, so resolveCategory
  // falls through to its ambiguous-leaf-title case, not the unknown-category one.
  const limits = new Map([['Coffee', { amount: 100, currency: 'PLN' }]])
  const dupTags = new Map(ds.tags)
  dupTags.set('coffee1', { id: 'coffee1', user: 10, title: 'Coffee', parent: 'eat', showIncome: false, showOutcome: true, changed: 0 })
  dupTags.set('coffee2', { id: 'coffee2', user: 10, title: 'Coffee', parent: 'health', showIncome: false, showOutcome: true, changed: 0 })
  const dupDs = { ...ds, tags: dupTags }
  expect(() => unresolvedLimits(dupDs, limits, new Map())).toThrow(expect.objectContaining({ code: 'INVALID_ARGS', message: expect.stringContaining('ambiguous') }))
})
it('budgetStatus reports unresolved limits passed in, defaulting to empty', () => {
  expect(budgetStatus(ds, new Map(), [], '2026-09', now).unresolved).toEqual([])
  const unresolved = [{ key: 'Nope', amount: 1, currency: 'EUR' }]
  expect(budgetStatus(ds, new Map(), [], '2026-09', now, unresolved).unresolved).toEqual(unresolved)
})
// A category spending in two or more currencies other than its own limit's
// currency exercises spentOtherCurrencies' own sort (a single other currency
// never actually calls the comparator).
it('sorts spentOtherCurrencies by currency name when a category spent in two other currencies', () => {
  const limits = new Map([['Groceries', { amount: 10000, currency: 'PLN' }]])
  function tx(over: Partial<Tx>): Tx {
    return {
      id: 'x', date: '2026-09-01', type: 'expense', amount: 10, currency: 'EUR',
      accountId: 'a', accountTitle: 'a', ownerId: 10, categoryId: 'food', topCategoryId: 'food',
      categoryPath: 'Groceries', merchant: null, payee: null, comment: null, hold: false, originalPayee: null, ...over,
    }
  }
  const monthTxs = [
    tx({ id: 'a1', currency: 'USD', amount: 5 }),
    tx({ id: 'a2', currency: 'GBP', amount: 7 }),
  ]
  const row = budgetStatus(ds, limits, monthTxs, '2026-09', now).rows[0]!
  expect(row.spentOtherCurrencies).toEqual([{ currency: 'GBP', amount: 7 }, { currency: 'USD', amount: 5 }])
})
