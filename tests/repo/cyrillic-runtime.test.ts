import { it, expect } from 'vitest'
import type { Dataset, Tx } from '../../src/query/model.js'
import type { ZmTag } from '../../src/api/types.js'
import { resolveCategory, applyFilters } from '../../src/query/filters.js'
import { spendBy } from '../../src/analytics/spend.js'

// The repository itself must contain no Cyrillic text (see no-cyrillic.test.ts),
// but the CLI is used against real ZenMoney data, where category titles are
// routinely Cyrillic. This proves category resolution, spend grouping, and
// sorting all still work correctly for a Cyrillic title mixed with a Latin
// one — without committing any literal Cyrillic source text: the title is
// built from its code points at runtime (it spells the Russian word for
// "Groceries").
const cyrillicTitle = String.fromCodePoint(0x041f, 0x0440, 0x043e, 0x0434, 0x0443, 0x043a, 0x0442, 0x044b)

// Review round item 11: a single Cyrillic title next to a Latin one doesn't
// actually prove the shared Intl.Collator('en') comparator is doing
// meaningful work — Latin capital letters sit at lower code points than any
// Cyrillic letter, so a naive `<` (code-point) sort would happen to produce
// the exact same order anyway. These two titles are the lowercase and
// uppercase spelling of the same three Cyrillic letters: by raw code point,
// the uppercase one sorts first (its code points are numerically lower), but
// Intl.Collator('en') sorts the lowercase one first instead (confirmed
// empirically, not assumed) — an order a plain `<` comparator gets wrong.
const cyrLower = String.fromCodePoint(0x0430, 0x0431, 0x0432) // lowercase (U+0430, U+0431, U+0432)
const cyrUpper = String.fromCodePoint(0x0410, 0x0411, 0x0412) // uppercase (U+0410, U+0411, U+0412)

function tag(id: string, title: string): ZmTag {
  return { id, user: 1, title, parent: null, showIncome: false, showOutcome: true, changed: 0 }
}

function tx(over: Partial<Tx>): Tx {
  return {
    id: 'x', date: '2026-09-01', type: 'expense', amount: 10, currency: 'EUR',
    accountId: 'a', accountTitle: 'a', ownerId: 1, categoryId: null, topCategoryId: null,
    categoryPath: '', merchant: null, payee: null, comment: null, hold: false, originalPayee: null, ...over,
  }
}

function dataset(): Dataset {
  const tags = new Map<string, ZmTag>([
    ['ru', tag('ru', cyrillicTitle)],
    ['en', tag('en', 'Apples')],
  ])
  return { users: [], accounts: new Map(), tags, instruments: new Map(), txs: [] }
}

it('resolves a Cyrillic category by exact title, case-insensitively', () => {
  const ds = dataset()
  expect(resolveCategory(ds, cyrillicTitle).id).toBe('ru')
  expect(resolveCategory(ds, cyrillicTitle.toUpperCase()).id).toBe('ru')
  expect(resolveCategory(ds, cyrillicTitle.toLowerCase()).id).toBe('ru')
})

it('--category filtering matches a Cyrillic category', () => {
  const ds = dataset()
  const txs = [
    tx({ id: 't1', categoryId: 'ru', topCategoryId: 'ru', categoryPath: cyrillicTitle }),
    tx({ id: 't2', categoryId: 'en', topCategoryId: 'en', categoryPath: 'Apples' }),
  ]
  ds.txs = txs
  expect(applyFilters(ds, { category: cyrillicTitle }).map(t => t.id)).toEqual(['t1'])
})

it('spend grouping and sorting handle a mix of Cyrillic and Latin category titles', () => {
  const txs = [
    tx({ id: 't1', categoryPath: cyrillicTitle, amount: 100 }),
    tx({ id: 't2', categoryPath: 'Apples', amount: 5 }),
  ]
  const groups = spendBy(txs, 'category')
  // The shared Intl.Collator('en') comparator (src/util.ts) sorts Latin before
  // this particular Cyrillic title deterministically, regardless of LANG.
  expect(groups.map(g => g.key)).toEqual(['Apples', cyrillicTitle])
  expect(groups.find(g => g.key === cyrillicTitle)!.amounts).toEqual([{ currency: 'EUR', amount: 100, count: 1 }])
})

it('sorts two Cyrillic titles (plus Latin) in an order a plain code-point comparator gets wrong', () => {
  // Sanity-check the premise against the real, unmodified JS runtime before
  // asserting anything about our own code: naive code-point order really
  // does disagree with Intl.Collator('en') for this exact pair.
  expect([cyrUpper, cyrLower].sort()).toEqual([cyrUpper, cyrLower]) // cyrUpper < cyrLower by code point
  expect(new Intl.Collator('en').compare(cyrLower, cyrUpper)).toBeLessThan(0) // but cyrLower sorts first

  const txs = [
    tx({ id: 't1', categoryPath: 'Apples', amount: 1 }),
    tx({ id: 't2', categoryPath: cyrUpper, amount: 2 }),
    tx({ id: 't3', categoryPath: cyrLower, amount: 3 }),
  ]
  const groups = spendBy(txs, 'category')
  // Matches Intl.Collator('en') order (Apples, then lowercase, then
  // uppercase), not naive code-point order (Apples, then uppercase, then
  // lowercase) — proving the shared comparator, not incidental ordering, is
  // what's actually driving this.
  expect(groups.map(g => g.key)).toEqual(['Apples', cyrLower, cyrUpper])
})
