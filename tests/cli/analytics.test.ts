import { it, expect } from 'vitest'
import { run } from '../../src/cli/program.js'
import { seededContext, testContext, withOwnersFile, FAMILY_OWNERS_YAML } from '../helpers.js'

const zm = async (args: string[]) => { const t = seededContext(); const code = await run(['node', 'zm', ...args], t.ctx); return { code, t } }

// Final-review item 2: a non-vacuous assertion — not just that the command
// succeeds or that meta.owner reflects the filter, but that the actual
// filtered AMOUNTS differ from the unfiltered ones. Derivation, from the
// synthetic fixture (tests/fixtures/diff.ts): FAMILY_OWNERS_YAML gives alex
// "Card PLN" (acc-pln) and sam "acc-partner". Groceries-tagged (food) txs
// in 2026-09 are t1 (expense 3000 PLN, acc-pln), t5 (refund 500 PLN,
// acc-pln), and t2 (expense 2000 PLN, acc-partner). spend = expense -
// refund, so alex-owned (acc-pln) net = 3000 - 500 = 2500 PLN over 2 txs;
// unfiltered (all accounts) net = 2500 + 2000 = 4500 PLN over 3 txs — the
// same 4500/count-3 figure the README's own worked example documents.
it('spend --owner <name> filters the actual amounts, not just meta, once owners.yaml exists', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  const alexCode = await run(['node', 'zm', 'spend', '--by', 'category', '--month', '2026-09', '--owner', 'ALEX'], t.ctx)
  expect(alexCode).toBe(0)
  const alexFood = t.json().data.find((g: any) => g.key === 'Groceries')
  expect(alexFood.amounts).toEqual([{ currency: 'PLN', amount: 2500, count: 2 }])
  expect(t.json().meta.owner).toBe('alex') // echoes the file's spelling, not the caller's "ALEX"

  const allT = seededContext()
  withOwnersFile(allT, FAMILY_OWNERS_YAML)
  const allCode = await run(['node', 'zm', 'spend', '--by', 'category', '--month', '2026-09'], allT.ctx) // --owner all (default)
  expect(allCode).toBe(0)
  const allFood = allT.json().data.find((g: any) => g.key === 'Groceries')
  expect(allFood.amounts).toEqual([{ currency: 'PLN', amount: 4500, count: 3 }])
})
// Same fixture, income instead of spend: t6 (income 4200 EUR, tag salary)
// is the only income-type tx, on acc-eur — assign it to alex and sam owns
// only acc-partner (no income there), so alex sees the income and sam sees
// none: two different owners, two different concrete results.
it('income --owner <name> filters the actual amounts once owners.yaml exists', async () => {
  const t = seededContext()
  withOwnersFile(t, 'owners:\n  alex:\n    accounts: ["Cash EUR"]\n  sam:\n    accounts: ["acc-partner"]\n')
  const alexCode = await run(['node', 'zm', 'income', '--by', 'category', '--month', '2026-09', '--owner', 'alex'], t.ctx)
  expect(alexCode).toBe(0)
  const salary = t.json().data.find((g: any) => g.key === 'Salary')
  expect(salary.amounts).toEqual([{ currency: 'EUR', amount: 4200, count: 1 }])
  expect(t.json().meta.owner).toBe('alex')

  t.out.length = 0 // t.json() reads all of t.out — clear it before the next run() reuses the same context
  const samCode = await run(['node', 'zm', 'income', '--by', 'category', '--month', '2026-09', '--owner', 'sam'], t.ctx)
  expect(samCode).toBe(0)
  expect(t.json().data).toEqual([])
})
// Same "Groceries" figures as the spend test above, compared across two
// whole months: 2026-09 alex-owned (acc-pln) net = 2500 PLN (t1 - t5, as
// above); 2026-08 alex-owned net = 45000 PLN (t17, the only acc-pln
// Groceries tx in August — expense, no refund that month).
it('compare --owner <name> filters both periods\' actual amounts once owners.yaml exists', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  const code = await run(['node', 'zm', 'compare', '--period', '2026-09', '--vs', '2026-08', '--by', 'category', '--owner', 'alex'], t.ctx)
  expect(code).toBe(0)
  const groceries = t.json().data.find((r: any) => r.key === 'Groceries')
  expect(groceries).toMatchObject({ currency: 'PLN', period: 2500, vs: 45000, diff: -42500 })
  expect(t.json().meta.owner).toBe('alex')
})
// Netflix (tag subs, merchant m-netflix, 12 EUR/month) runs on acc-eur —
// owned here by alex, not sam (who owns only acc-partner, with no
// subscriptions at all) — so alex's recurring list includes it and sam's
// doesn't: a concrete difference, not just a meta echo.
it('recurring --owner <name> filters the actual recurring list once owners.yaml exists', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  withOwnersFile(t, 'owners:\n  alex:\n    accounts: ["Cash EUR"]\n  sam:\n    accounts: ["acc-partner"]\n')
  const alexCode = await run(['node', 'zm', 'recurring', '--owner', 'alex'], t.ctx)
  expect(alexCode).toBe(0)
  const netflix = t.json().data.find((r: any) => r.merchant === 'Netflix')
  expect(netflix).toMatchObject({ avgAmount: 12, currency: 'EUR', periodicity: 'monthly' })
  expect(t.json().meta.owner).toBe('alex')

  t.out.length = 0 // t.json() reads all of t.out — clear it before the next run() reuses the same context
  const samCode = await run(['node', 'zm', 'recurring', '--owner', 'sam'], t.ctx)
  expect(samCode).toBe(0)
  expect(t.json().data.some((r: any) => r.merchant === 'Netflix')).toBe(false)
})

it('spend --by category --month', async () => {
  const { code, t } = await zm(['spend', '--by', 'category', '--month', '2026-09', '--owner', 'me'])
  expect(code).toBe(0)
  const food = t.json().data.find((g: any) => g.key === 'Groceries')
  expect(food.amounts).toEqual([{ currency: 'PLN', amount: 2500, count: 2 }])
  expect(t.json().meta).toMatchObject({ by: 'category', from: '2026-09-01', to: '2026-09-30', owner: 'me' })
})
it('spend --tree only with category', async () => {
  const { code } = await zm(['spend', '--by', 'month', '--tree'])
  expect(code).toBe(2)
})
it('spend table format flattens groups', async () => {
  const { t } = await zm(['spend', '--by', 'category', '--month', '2026-09', '--format', 'table'])
  expect(t.out.join('')).toMatch(/Groceries\s+PLN\s+4500\s+3/)
})
it('income --by month', async () => {
  const { t } = await zm(['income', '--by', 'month'])
  expect(t.json().data).toEqual([{ key: '2026-09', amounts: [{ currency: 'EUR', amount: 4200, count: 1 }] }])
})
it('compare', async () => {
  const { t } = await zm(['compare', '--period', '2026-09', '--vs', '2026-08', '--by', 'category', '--category', 'Food'])
  expect(t.json().data).toEqual([{ key: 'Food/Cafe', currency: 'EUR', period: 20, vs: 30, diff: -10, diffPct: -33.3 }])
})
it('compare meta lists every applied filter', async () => {
  const { t } = await zm(['compare', '--period', '2026-09', '--vs', '2026-08', '--category', 'Food', '--account', 'Cash EUR', '--currency', 'EUR', '--owner', 'me'])
  expect(t.json().meta).toMatchObject({ category: 'Food', account: 'acc-eur', currency: 'EUR', owner: 'me' })
})
it('compare meta reports null for filters not given', async () => {
  const { t } = await zm(['compare', '--period', '2026-09', '--vs', '2026-08'])
  expect(t.json().meta).toMatchObject({ category: null, account: null, currency: null, owner: 'all' })
})
it('recurring', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  expect(await run(['node', 'zm', 'recurring', '--months', '4'], t.ctx)).toBe(0)
  expect(t.json().data[0]).toMatchObject({ merchant: 'Netflix', periodicity: 'monthly' })
  expect(t.json().meta).toEqual(expect.objectContaining({ months: 4, minMonths: 3 }))
})
it('spend warns on an unknown --currency but still succeeds', async () => {
  const { code, t } = await zm(['spend', '--by', 'category', '--currency', 'ZZZ'])
  expect(code).toBe(0)
  expect(t.json().warnings).toContain('unknown currency: ZZZ')
})
it('compare warns on an unknown --currency but still succeeds', async () => {
  const { t } = await zm(['compare', '--period', '2026-09', '--vs', '2026-08', '--currency', 'ZZZ'])
  expect(t.json().warnings).toContain('unknown currency: ZZZ')
})
it('recurring meta lists every applied filter', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  expect(await run(['node', 'zm', 'recurring', '--category', 'Subscriptions', '--account', 'Cash EUR', '--currency', 'EUR', '--owner', 'me'], t.ctx)).toBe(0)
  expect(t.json().meta).toMatchObject({ category: 'Subscriptions', account: 'acc-eur', currency: 'EUR', owner: 'me' })
})
it('recurring meta reports null for filters not given', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  expect(await run(['node', 'zm', 'recurring'], t.ctx)).toBe(0)
  expect(t.json().meta).toMatchObject({ category: null, account: null, currency: null, owner: 'all' })
})
it('recurring finds a subscription with no merchant/payee/originalPayee via the comment fallback', async () => {
  const t = seededContext({ now: () => new Date('2026-03-20T12:00:00') })
  expect(await run(['node', 'zm', 'recurring', '--months', '4'], t.ctx)).toBe(0)
  expect(t.json().data).toEqual([
    expect.objectContaining({ merchant: 'Music Plus', source: 'comment', periodicity: 'monthly' }),
  ])
})
it('recurring rejects invalid --months', async () => {
  for (const months of ['0', '37', '2.5']) {
    const { code, t } = await zm(['recurring', '--months', months])
    expect(code).toBe(2)
    expect(t.errJson().error.code).toBe('INVALID_ARGS')
  }
})
it('recurring rejects --min-months greater than --months', async () => {
  const { code, t } = await zm(['recurring', '--months', '6', '--min-months', '7'])
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
})
it('option-shape validation happens before the cache check: no cache, bad args still exit 2', async () => {
  const noCache = testContext()
  expect(await run(['node', 'zm', 'spend', '--by', 'nope'], noCache.ctx)).toBe(2)
  expect(await run(['node', 'zm', 'compare', '--period', 'nope', '--vs', '2026-08'], noCache.ctx)).toBe(2)
  expect(await run(['node', 'zm', 'recurring', '--months', '0'], noCache.ctx)).toBe(2)
  expect(await run(['node', 'zm', 'tx', '--month', '2026-13'], noCache.ctx)).toBe(2)
  expect(await run(['node', 'zm', 'income', '--by', 'nope'], noCache.ctx)).toBe(2)
})
it('compare validates --period/--vs as real calendar ranges (from <= to) before the cache check', async () => {
  const noCache = testContext()
  expect(await run(['node', 'zm', 'compare', '--period', '2026-02-30..2026-03-01', '--vs', '2026-08'], noCache.ctx)).toBe(2)
  expect(await run(['node', 'zm', 'compare', '--period', '2026-09-10..2026-09-01', '--vs', '2026-08'], noCache.ctx)).toBe(2)
})
it('an empty --currency is rejected before the cache check, for every command that accepts it', async () => {
  const noCache = testContext()
  for (const args of [
    ['spend', '--by', 'category', '--currency', ''],
    ['income', '--by', 'category', '--currency', ''],
    ['compare', '--period', '2026-09', '--vs', '2026-08', '--currency', ''],
    ['recurring', '--currency', ''],
    ['tx', '--currency', ''],
  ]) {
    const code = await run(['node', 'zm', ...args], noCache.ctx)
    expect(code).toBe(2)
    expect(noCache.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--currency must not be empty' })
    noCache.err.length = 0
  }
})
