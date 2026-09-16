import { it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBudgetFile, mergeBudget, loadBudget } from '../../src/budget/files.js'

// `yaml`'s ESM namespace can't be spied on directly (its exports aren't
// configurable), so `parse` is wrapped here to let one test force a
// non-Error throw — the only way parseBudgetFile's `e instanceof Error ?
// e.message : String(e)` fallback arm can ever be exercised, since the real
// `yaml` parser only ever throws actual Error instances.
let forcedParseError: unknown
vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yaml')>()
  return {
    ...actual,
    parse: (text: string) => {
      if (forcedParseError !== undefined) {
        const e = forcedParseError
        forcedParseError = undefined
        throw e
      }
      return actual.parse(text)
    },
  }
})

// Unconditional reset: the mock above only clears the flag when `parse` is
// actually reached, so a test that sets it and then throws or returns before
// calling `parse` would otherwise leak it into the next test in this file.
afterEach(() => {
  forcedParseError = undefined
})

it('merges template and month', () => {
  const base = parseBudgetFile('currency: PLN\nlimits:\n  Groceries: 50000\n  Subscriptions: { amount: 15, currency: eur }\n  Health: 10000\n', 'default.yaml')
  const month = parseBudgetFile('currency: EUR\nlimits:\n  Health: null\n  Food/Cafe: 100\n', '2026-10.yaml')
  expect([...mergeBudget(base, month)]).toEqual([
    ['Groceries', { amount: 50000, currency: 'PLN' }],
    ['Subscriptions', { amount: 15, currency: 'EUR' }],
    ['Food/Cafe', { amount: 100, currency: 'EUR' }],
  ])
})
it('rejects bad shapes', () => {
  expect(() => parseBudgetFile('- a', 'x.yaml')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  expect(() => parseBudgetFile('limits:\n  A: -1\n', 'x.yaml')).toThrow(/x.yaml/)
  expect(() => mergeBudget(parseBudgetFile('limits:\n  A: 1\n', 'x'), null)).toThrow(/no currency/)
})
it('rejects unknown top-level keys', () => {
  expect(() => parseBudgetFile('currency: PLN\nlimts:\n  Groceries: 1\n', 'default.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'default.yaml: unknown key "limts"' }),
  )
})
it('rejects __proto__/constructor/prototype as limit keys', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    expect(() => parseBudgetFile(`limits:\n  ${key}: 1\n`, 'x.yaml')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGS' }),
    )
  }
})
it('treats a comment-only limits: block (parses as null) as empty', () => {
  expect(parseBudgetFile('currency: EUR\nlimits:\n  # Groceries: 0\n', 'default.yaml')).toEqual({ currency: 'EUR', limits: {} })
})
it('loadBudget reads existing files and fails when none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-b-'))
  expect(() => loadBudget(dir, '2026-09')).toThrow(expect.objectContaining({ hint: 'run zm budget init' }))
  writeFileSync(join(dir, 'default.yaml'), 'currency: PLN\nlimits:\n  Groceries: 1\n')
  expect(loadBudget(dir, '2026-09').sources).toEqual([join(dir, 'default.yaml')])
})
// Only the default.yaml branch was exercised above — loadBudget must also
// read an existing month file, merge it over the default, and attribute
// keySources correctly to whichever file actually set (or overrode) each key.
it('loadBudget also reads an existing month file and merges it over the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-b-'))
  const defaultPath = join(dir, 'default.yaml')
  const monthPath = join(dir, '2026-10.yaml')
  writeFileSync(defaultPath, 'currency: PLN\nlimits:\n  Groceries: 50000\n  Health: 10000\n')
  writeFileSync(monthPath, 'limits:\n  Health: null\n  Food/Cafe: 100\n')
  const result = loadBudget(dir, '2026-10')
  expect(result.sources).toEqual([defaultPath, monthPath])
  expect([...result.limits]).toEqual([
    ['Groceries', { amount: 50000, currency: 'PLN' }],
    ['Food/Cafe', { amount: 100, currency: 'PLN' }],
  ])
  // Health was set by the default, then deleted by the month override — it
  // must not appear in keySources (which only tracks keys that survived).
  expect(result.keySources.get('Groceries')).toBe(defaultPath)
  expect(result.keySources.get('Food/Cafe')).toBe(monthPath)
  expect(result.keySources.has('Health')).toBe(false)
})
it('loadBudget reads only the month file when there is no default.yaml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-b-'))
  const monthPath = join(dir, '2026-11.yaml')
  writeFileSync(monthPath, 'currency: EUR\nlimits:\n  Groceries: 20\n')
  const result = loadBudget(dir, '2026-11')
  expect(result.sources).toEqual([monthPath])
  expect(result.keySources.get('Groceries')).toBe(monthPath)
})
it('rejects invalid yaml syntax with the source name in the error', () => {
  expect(() => parseBudgetFile('limits:\n  Groceries: [1, 2\n', 'x.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: expect.stringContaining('x.yaml: invalid yaml:') }),
  )
})
it('rejects an object-form limit with a non-numeric or missing amount', () => {
  expect(() => parseBudgetFile('limits:\n  Groceries: { amount: "x" }\n', 'x.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'x.yaml: limit "Groceries" must have a finite "amount" >= 0' }),
  )
  expect(() => parseBudgetFile('limits:\n  Groceries: { currency: EUR }\n', 'x.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS' }),
  )
})
it('rejects an object-form limit with a non-string currency', () => {
  expect(() => parseBudgetFile('limits:\n  Groceries: { amount: 5, currency: 5 }\n', 'x.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'x.yaml: limit "Groceries" currency must be a string' }),
  )
})
it('accepts an object-form limit with an explicit currency', () => {
  expect(parseBudgetFile('limits:\n  Groceries: { amount: 5, currency: EUR }\n', 'x.yaml')).toEqual({
    limits: { Groceries: { amount: 5, currency: 'EUR' } },
  })
})
it('rejects a limit value that is neither a number nor an object (e.g. an array)', () => {
  expect(() => parseBudgetFile('limits:\n  Groceries: [1, 2]\n', 'x.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'x.yaml: limit "Groceries" has an invalid shape' }),
  )
})
it('accepts an object-form limit with no explicit currency', () => {
  expect(parseBudgetFile('limits:\n  Groceries: { amount: 5 }\n', 'x.yaml')).toEqual({
    limits: { Groceries: { amount: 5 } },
  })
})
it('wraps a non-Error value thrown by the yaml parser using String(e)', () => {
  forcedParseError = 'boom'
  expect(() => parseBudgetFile('currency: PLN\n', 'x.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'x.yaml: invalid yaml: boom' }),
  )
})
it('treats both an empty yaml document (undefined) and an explicit null document as empty', () => {
  expect(parseBudgetFile('', 'x.yaml')).toEqual({})
  expect(parseBudgetFile('null\n', 'x.yaml')).toEqual({})
})
it('rejects a non-string top-level currency', () => {
  expect(() => parseBudgetFile('currency: 5\n', 'x.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'x.yaml: "currency" must be a string' }),
  )
})
it('parses a file with only a currency and no limits key at all', () => {
  expect(parseBudgetFile('currency: PLN\n', 'x.yaml')).toEqual({ currency: 'PLN' })
})
it('rejects a non-object limits value', () => {
  expect(() => parseBudgetFile('limits: 5\n', 'x.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'x.yaml: "limits" must be an object' }),
  )
})
// mergeBudget and keySources must both skip a null-valued BASE limit outright
// (distinct from the "merges template and month" test above, whose null entry
// is in the month override, deleting a base key rather than being one itself):
// a null base value should never reach toLimitSpec (no currency to resolve)
// and should never be attributed to any source.
it('loadBudget skips a null-valued base limit entirely, in both the merged map and keySources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-b-'))
  writeFileSync(join(dir, 'default.yaml'), 'currency: PLN\nlimits:\n  Ghost: null\n  Groceries: 100\n')
  const result = loadBudget(dir, '2026-09')
  expect([...result.limits.keys()]).toEqual(['Groceries'])
  expect(result.keySources.has('Ghost')).toBe(false)
})
