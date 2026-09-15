import { it, expect } from 'vitest'
import { parse } from 'yaml'
import { loadDataset } from '../../src/query/model.js'
import type { Tx } from '../../src/query/model.js'
import { suggestBudget, suggestWindow } from '../../src/budget/suggest.js'
import { parseBudgetFile } from '../../src/budget/files.js'
import { fixtureStore } from '../helpers.js'

const ds = loadDataset(fixtureStore())
const WINDOW = { from: '2026-06', to: '2026-08' }

function tx(over: Partial<Tx>): Tx {
  return {
    id: 'x', date: '2026-06-01', type: 'expense', amount: 10, currency: 'EUR',
    accountId: 'a', accountTitle: 'a', ownerId: 1, owner: null, categoryId: 'c', topCategoryId: 'c',
    categoryPath: 'Taxi', merchant: null, payee: null, comment: null, hold: false, originalPayee: null, ...over,
  }
}

it('median of previous full months', () => {
  const text = suggestBudget(ds.txs, WINDOW, '2026-09', 'EUR')
  expect(text).toMatch(/^# zm budget suggest: median of 2026-06\.\.2026-08, generated for 2026-09/)
  expect(parse(text)).toEqual({ currency: 'EUR', limits: { 'Subscriptions': 12, 'Groceries': { amount: 45000, currency: 'PLN' } } })
})
it('skips pairs whose median spend is <= 0 (refunds outweigh spend)', () => {
  const txs: Tx[] = [
    tx({ id: 't1', date: '2026-06-05', type: 'refund', amount: 5 }),
    tx({ id: 't2', date: '2026-07-05', type: 'refund', amount: 5 }),
    tx({ id: 't3', date: '2026-08-05', type: 'expense', amount: 1 }),
  ]
  const text = suggestBudget(txs, WINDOW, '2026-09', 'EUR')
  expect(parse(text).limits).toEqual({})
  expect(() => parseBudgetFile(text, 'suggested.yaml')).not.toThrow()
})
it('one category kept in two currencies: keeps the more-recurring pair, comments the other', () => {
  const txs: Tx[] = [
    tx({ id: 'e1', date: '2026-06-01', currency: 'EUR', amount: 2 }),
    tx({ id: 'e2', date: '2026-07-01', currency: 'EUR', amount: 2 }),
    tx({ id: 'e3', date: '2026-08-01', currency: 'EUR', amount: 2 }),
    tx({ id: 'r1', date: '2026-06-02', currency: 'PLN', amount: 1000 }),
    tx({ id: 'r2', date: '2026-07-02', currency: 'PLN', amount: 1000 }),
  ]
  const text = suggestBudget(txs, WINDOW, '2026-09', 'EUR')
  expect(text).toMatch(/# also spent: Taxi 1000 PLN\nlimits:/)
  expect(parse(text)).toEqual({ currency: 'EUR', limits: { 'Taxi': 2 } })
})
// The tie-break inside pairs.sort (same path, same nonZeroMonths) prefers
// whichever currency became the file's own currency, then falls back to
// alphabetical — distinct from the "one category kept in two currencies"
// test above, whose two pairs differ in nonZeroMonths and so never reach
// the tie-break lines. With three currencies each kept exactly once, the
// file currency itself is chosen alphabetically (AUD), not the passed-in
// mainCurrency (EUR) — mainCurrency only matters when nothing qualifies.
it('one category tied across three currencies: keeps the file currency, comments the rest alphabetically', () => {
  const txs: Tx[] = [
    tx({ id: 'e1', date: '2026-06-01', currency: 'EUR', amount: 4 }),
    tx({ id: 'e2', date: '2026-07-01', currency: 'EUR', amount: 4 }),
    tx({ id: 'u1', date: '2026-06-02', currency: 'USD', amount: 4 }),
    tx({ id: 'u2', date: '2026-07-02', currency: 'USD', amount: 4 }),
    tx({ id: 'a1', date: '2026-06-03', currency: 'AUD', amount: 4 }),
    tx({ id: 'a2', date: '2026-07-03', currency: 'AUD', amount: 4 }),
  ]
  const text = suggestBudget(txs, WINDOW, '2026-09', 'EUR')
  expect(parse(text)).toEqual({ currency: 'AUD', limits: { Taxi: 4 } })
  expect(text).toMatch(/# also spent: Taxi 4 EUR\n# also spent: Taxi 4 USD\nlimits:/)
})
// A-15: with no qualifying pairs at all, `currency` must still be the main
// user's currency, not an empty string (which wouldn't even round-trip
// through parseBudgetFile without an explicit per-limit currency).
it('with no qualifying pairs, currency falls back to the given main currency instead of empty', () => {
  const text = suggestBudget([], WINDOW, '2026-09', 'PLN')
  expect(parse(text)).toEqual({ currency: 'PLN', limits: {} })
  expect(() => parseBudgetFile(text, 'suggested.yaml')).not.toThrow()
})
it('suggestWindow: uses only full months, capped by the not-yet-complete current month', () => {
  // now is mid-September: September itself hasn't fully elapsed, so even
  // though the default target (October) would allow September in the
  // window, it's excluded — the window ends at August.
  const now = new Date('2026-09-15T12:00:00')
  expect(suggestWindow('2026-10', 3, now)).toEqual({ from: '2026-06', to: '2026-08' })
})
it('suggestWindow: target closer than current month still caps at target - 1', () => {
  const now = new Date('2026-09-15T12:00:00')
  expect(suggestWindow('2026-09', 3, now)).toEqual({ from: '2026-06', to: '2026-08' })
})
it('suggestWindow: a target in the past caps at target - 1, not the current month', () => {
  const now = new Date('2026-09-15T12:00:00')
  expect(suggestWindow('2026-03', 3, now)).toEqual({ from: '2025-12', to: '2026-02' })
})
it('suggestWindow: a target far in the future is still capped by the current month', () => {
  const now = new Date('2026-09-15T12:00:00')
  expect(suggestWindow('2027-01', 3, now)).toEqual({ from: '2026-06', to: '2026-08' })
})
