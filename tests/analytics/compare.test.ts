import { it, expect } from 'vitest'
import type { Tx } from '../../src/query/model.js'
import { loadDataset } from '../../src/query/model.js'
import { applyFilters } from '../../src/query/filters.js'
import { compare, parsePeriod } from '../../src/analytics/compare.js'
import { fixtureStore } from '../helpers.js'

const ds = loadDataset(fixtureStore())
const p = (s: string) => applyFilters(ds, parsePeriod(s))

it('parses periods', () => {
  expect(parsePeriod('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  expect(parsePeriod('2026-09-01..2026-09-10')).toEqual({ from: '2026-09-01', to: '2026-09-10' })
  expect(() => parsePeriod('last month')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
// A-8: parsePeriod validates a range as real calendar dates with from <= to
// (via the shared resolvePeriod), not just the YYYY-MM-DD..YYYY-MM-DD shape.
it('rejects a range with an impossible calendar date', () => {
  expect(() => parsePeriod('2026-02-30..2026-03-01')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
it('rejects a range where from is after to', () => {
  expect(() => parsePeriod('2026-09-10..2026-09-01')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
it('compares totals per currency', () => {
  expect(compare(p('2026-09'), p('2026-08'), 'total')).toEqual([
    { key: 'total', currency: 'EUR', period: 42, vs: 42, diff: 0, diffPct: 0 },
    { key: 'total', currency: 'PLN', period: 89500, vs: 45000, diff: 44500, diffPct: 98.9 },
  ])
})
it('category rows include keys missing on one side', () => {
  const rows = compare(p('2026-09'), p('2026-08'), 'category')
  expect(rows.find(r => r.key === 'Food/Cafe')).toEqual({ key: 'Food/Cafe', currency: 'EUR', period: 20, vs: 30, diff: -10, diffPct: -33.3 })
  expect(rows.find(r => r.key === 'Health/Dentist')).toMatchObject({ vs: 0, diffPct: null })
})
// A category with no transactions at all on one side means that side's
// per-currency map is entirely absent (not just missing one currency) — the
// case above only exercises a missing currency within an existing map.
it('a category present only in the period (nothing at all on the vs side) still gets a row', () => {
  function tx(over: Partial<Tx>): Tx {
    return {
      id: 'x', date: '2026-09-01', type: 'expense', amount: 10, currency: 'EUR',
      accountId: 'a', accountTitle: 'a', ownerId: 1, categoryId: 'c', topCategoryId: 'c',
      categoryPath: 'OnlyPeriod', merchant: null, payee: null, comment: null, hold: false, originalPayee: null, ...over,
    }
  }
  const periodTxs = [tx({ id: 'p1' })]
  const vsTxs: Tx[] = []
  expect(compare(periodTxs, vsTxs, 'category')).toEqual([
    { key: 'OnlyPeriod', currency: 'EUR', period: 10, vs: 0, diff: 10, diffPct: null },
  ])
})
it('a category present only on the vs side (nothing at all in the period) still gets a row', () => {
  function tx(over: Partial<Tx>): Tx {
    return {
      id: 'x', date: '2026-08-01', type: 'expense', amount: 15, currency: 'PLN',
      accountId: 'a', accountTitle: 'a', ownerId: 1, categoryId: 'c', topCategoryId: 'c',
      categoryPath: 'OnlyVs', merchant: null, payee: null, comment: null, hold: false, originalPayee: null, ...over,
    }
  }
  const periodTxs: Tx[] = []
  const vsTxs = [tx({ id: 'v1' })]
  expect(compare(periodTxs, vsTxs, 'category')).toEqual([
    { key: 'OnlyVs', currency: 'PLN', period: 0, vs: 15, diff: -15, diffPct: -100 },
  ])
})
