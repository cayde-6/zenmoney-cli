import { it, expect } from 'vitest'
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
it('compares totals per currency', () => {
  expect(compare(p('2026-09'), p('2026-08'), 'total')).toEqual([
    { key: 'total', currency: 'EUR', period: 42, vs: 42, diff: 0, diffPct: 0 },
    { key: 'total', currency: 'PLN', period: 89500, vs: 45000, diff: 44500, diffPct: 98.9 },
  ])
})
it('category rows include keys missing on one side', () => {
  const rows = compare(p('2026-09'), p('2026-08'), 'category')
  expect(rows.find(r => r.key === 'Еда/Кафе')).toEqual({ key: 'Еда/Кафе', currency: 'EUR', period: 20, vs: 30, diff: -10, diffPct: -33.3 })
  expect(rows.find(r => r.key === 'Здоровье/Стоматология')).toMatchObject({ vs: 0, diffPct: null })
})
