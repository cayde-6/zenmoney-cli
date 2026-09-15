import { it, expect } from 'vitest'
import { run } from '../../src/cli/program.js'
import { seededContext, testContext } from '../helpers.js'

const zm = async (args: string[]) => { const t = seededContext(); const code = await run(['node', 'zm', ...args], t.ctx); return { code, t } }

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
