import { it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBudgetFile, mergeBudget, loadBudget } from '../../src/budget/files.js'

it('merges template and month', () => {
  const base = parseBudgetFile('currency: PLN\nlimits:\n  Продукты: 50000\n  Подписки: { amount: 15, currency: eur }\n  Здоровье: 10000\n', 'default.yaml')
  const month = parseBudgetFile('currency: EUR\nlimits:\n  Здоровье: null\n  Еда/Кафе: 100\n', '2026-10.yaml')
  expect([...mergeBudget(base, month)]).toEqual([
    ['Продукты', { amount: 50000, currency: 'PLN' }],
    ['Подписки', { amount: 15, currency: 'EUR' }],
    ['Еда/Кафе', { amount: 100, currency: 'EUR' }],
  ])
})
it('rejects bad shapes', () => {
  expect(() => parseBudgetFile('- a', 'x.yaml')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  expect(() => parseBudgetFile('limits:\n  A: -1\n', 'x.yaml')).toThrow(/x.yaml/)
  expect(() => mergeBudget(parseBudgetFile('limits:\n  A: 1\n', 'x'), null)).toThrow(/no currency/)
})
it('rejects unknown top-level keys', () => {
  expect(() => parseBudgetFile('currency: PLN\nlimts:\n  Продукты: 1\n', 'default.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'default.yaml: unknown key "limts"' }),
  )
})
it('treats a comment-only limits: block (parses as null) as empty', () => {
  expect(parseBudgetFile('currency: EUR\nlimits:\n  # Продукты: 0\n', 'default.yaml')).toEqual({ currency: 'EUR', limits: {} })
})
it('loadBudget reads existing files and fails when none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-b-'))
  expect(() => loadBudget(dir, '2026-09')).toThrow(expect.objectContaining({ hint: 'run zm budget init' }))
  writeFileSync(join(dir, 'default.yaml'), 'currency: PLN\nlimits:\n  Продукты: 1\n')
  expect(loadBudget(dir, '2026-09').sources).toEqual([join(dir, 'default.yaml')])
})
