import { it, expect } from 'vitest'
import { loadDataset } from '../../src/query/model.js'
import { applyFilters } from '../../src/query/filters.js'
import { budgetStatus, monthElapsedPct } from '../../src/budget/status.js'
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
    ['Продукты', { amount: 10000, currency: 'PLN' }],
    ['Здоровье', { amount: 8000, currency: 'PLN' }],
    ['Здоровье/Стоматология', { amount: 100000, currency: 'PLN' }],
    ['Еда', { amount: 15, currency: 'PLN' }],
  ])
  const st = budgetStatus(ds, limits, applyFilters(ds, { month: '2026-09' }), '2026-09', now)
  expect(st.monthElapsedPct).toBe(50)
  expect(st.rows).toEqual([
    { category: 'Еда', categoryId: 'eat', currency: 'PLN', planned: 15, spent: 0, spentOtherCurrencies: [{ currency: 'EUR', amount: 20 }], remaining: 15, usedPct: 0, monthElapsedPct: 50, pace: -50 },
    { category: 'Здоровье', categoryId: 'health', currency: 'PLN', planned: 8000, spent: 5000, spentOtherCurrencies: [], remaining: 3000, usedPct: 62.5, monthElapsedPct: 50, pace: 12.5 },
    { category: 'Здоровье/Стоматология', categoryId: 'dent', currency: 'PLN', planned: 100000, spent: 80000, spentOtherCurrencies: [], remaining: 20000, usedPct: 80, monthElapsedPct: 50, pace: 30 },
    { category: 'Продукты', categoryId: 'food', currency: 'PLN', planned: 10000, spent: 4500, spentOtherCurrencies: [], remaining: 5500, usedPct: 45, monthElapsedPct: 50, pace: -5 },
  ])
  expect(st.unplanned.map(g => g.key)).toEqual(['Без категории', 'Подписки'])
})
it('unknown limit category fails with suggestion', () => {
  expect(() => budgetStatus(ds, new Map([['Продукт', { amount: 1, currency: 'PLN' }]]), [], '2026-09', now))
    .toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
it('two limit keys resolving to the same category fail, even written differently', () => {
  const limits = new Map([
    ['Кафе', { amount: 100, currency: 'PLN' }],
    ['Еда/Кафе', { amount: 200, currency: 'PLN' }],
  ])
  expect(() => budgetStatus(ds, limits, [], '2026-09', now)).toThrow(/same category/)
  expect(() => budgetStatus(ds, limits, [], '2026-09', now)).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
