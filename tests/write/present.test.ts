import { it, expect } from 'vitest'
import { balanceImpact, changeViews, tableRows, shellQuote, applyCommand } from '../../src/write/present.js'
import { planAdd, planDelete, planEdit, type PlannedChange } from '../../src/write/plan.js'
import { loadDataset, type Dataset } from '../../src/query/model.js'
import { fixtureStore } from '../helpers.js'
import type { ZmAccount, ZmTransaction } from '../../src/api/types.js'

const s = fixtureStore()
const ds: Dataset = loadDataset(s)

// Clones a Dataset with extra/overridden accounts merged in, for tests that
// need account shapes the shared fixture doesn't have (a duplicate title,
// an instrument id that doesn't resolve).
function withAccounts(base: Dataset, accounts: ZmAccount[]): Dataset {
  const accountsMap = new Map(base.accounts)
  for (const a of accounts) accountsMap.set(a.id, a)
  return { ...base, accounts: accountsMap }
}

// A minimal synthetic single-currency-simple create change contributing
// `amount` to `accountId`, for tests that only care about balanceImpact's
// account/sort handling and not about a realistic plan.
function creditChange(id: string, accountId: string, amount: number): PlannedChange {
  const next: ZmTransaction = {
    id, user: 10, date: '2026-09-01', income: amount, outcome: 0,
    incomeAccount: accountId, outcomeAccount: accountId, incomeInstrument: 100, outcomeInstrument: 100,
    tag: null, merchant: null, payee: null, comment: null, deleted: false, created: 1, changed: 1,
  }
  return { op: 'create', id, base: null, next, set: {} }
}

// balanceImpact

it('balanceImpact: amount edit deltas the account', () => {
  const t1 = s.getTransaction('t1')!
  const impact = balanceImpact(ds, planEdit(ds, [t1], { amount: 2500 }))
  expect(impact).toEqual([{ accountId: 'acc-pln', accountTitle: 'Card PLN', currency: 'PLN', delta: 500 }])
})

it('balanceImpact: delete adds back the removed amount', () => {
  const t1 = s.getTransaction('t1')!
  const impact = balanceImpact(ds, planDelete([t1]))
  expect(impact).toEqual([{ accountId: 'acc-pln', accountTitle: 'Card PLN', currency: 'PLN', delta: 3000 }])
})

it('balanceImpact: create adds the full amount', () => {
  const impact = balanceImpact(ds, planAdd(ds, { id: 'new-1', kind: 'income', amount: 10, accountId: 'acc-eur', date: '2026-09-20' }))
  expect(impact).toEqual([{ accountId: 'acc-eur', accountTitle: 'Cash EUR', currency: 'EUR', delta: 10 }])
})

it('balanceImpact: moving accounts produces two entries, sorted by account title', () => {
  const t1 = s.getTransaction('t1')!
  const impact = balanceImpact(ds, planEdit(ds, [t1], { accountId: 'acc-partner' }))
  expect(impact).toEqual([
    { accountId: 'acc-pln', accountTitle: 'Card PLN', currency: 'PLN', delta: 3000 },
    { accountId: 'acc-partner', accountTitle: 'Card Partner', currency: 'PLN', delta: -3000 },
  ])
})

it('balanceImpact: no money change yields no entries', () => {
  const t1 = s.getTransaction('t1')!
  expect(balanceImpact(ds, planEdit(ds, [t1], { comment: 'hi' }))).toEqual([])
})

it('balanceImpact: unknown account falls back to its id and empty currency', () => {
  const base: ZmTransaction = {
    id: 'x', user: 10, date: '2026-09-01', income: 0, outcome: 100, incomeAccount: 'ghost', outcomeAccount: 'ghost',
    incomeInstrument: 999, outcomeInstrument: 999, tag: null, merchant: null, payee: null, comment: null,
    deleted: false, created: 1, changed: 1,
  }
  const next: ZmTransaction = { ...base, outcome: 50 }
  const changes: PlannedChange[] = [{ op: 'update', id: 'x', base, next, set: { outcome: 50 } }]
  expect(balanceImpact(ds, changes)).toEqual([{ accountId: 'ghost', accountTitle: 'ghost', currency: '', delta: 50 }])
})

it('balanceImpact: deleting a cross-currency transfer produces one entry per side', () => {
  const t7 = s.getTransaction('t7')! // transfer: 100 EUR out of acc-eur, 11700 PLN into acc-pln
  expect(t7.outcome).toBe(100)
  expect(t7.outcomeAccount).toBe('acc-eur')
  expect(t7.income).toBe(11700)
  expect(t7.incomeAccount).toBe('acc-pln')
  const impact = balanceImpact(ds, planDelete([t7]))
  expect(impact).toEqual([
    { accountId: 'acc-pln', accountTitle: 'Card PLN', currency: 'PLN', delta: -11700 },
    { accountId: 'acc-eur', accountTitle: 'Cash EUR', currency: 'EUR', delta: 100 },
  ])
})

it('balanceImpact: deleting a debt row produces one entry per side', () => {
  const t8 = s.getTransaction('t8')! // debt: 50 EUR out of acc-eur, 50 EUR into acc-debt
  expect(t8.outcome).toBe(50)
  expect(t8.outcomeAccount).toBe('acc-eur')
  expect(t8.income).toBe(50)
  expect(t8.incomeAccount).toBe('acc-debt')
  const impact = balanceImpact(ds, planDelete([t8]))
  expect(impact).toEqual([
    { accountId: 'acc-eur', accountTitle: 'Cash EUR', currency: 'EUR', delta: 50 },
    { accountId: 'acc-debt', accountTitle: 'Debts', currency: 'EUR', delta: -50 },
  ])
})

it('balanceImpact: accounts tied on title sort by accountId ascending', () => {
  const tied = (id: string): ZmAccount => ({
    id, user: 10, instrument: 100, type: 'cash', title: 'Same Title', balance: 0, inBalance: true, archive: false, changed: 1,
  })
  const dsTied = withAccounts(ds, [tied('acc-c'), tied('acc-a'), tied('acc-b')])
  // Insertion order deliberately not id-ascending, so the result only
  // matches if the tie-break sort actually runs (both its arms: acc-a
  // sorts before acc-b, and acc-c sorts after both).
  const changes = [creditChange('y1', 'acc-c', 10), creditChange('y2', 'acc-a', 20), creditChange('y3', 'acc-b', 30)]
  const impact = balanceImpact(dsTied, changes)
  expect(impact.map(i => i.accountId)).toEqual(['acc-a', 'acc-b', 'acc-c'])
})

it('balanceImpact: a known account with an unresolvable instrument id falls back to empty currency', () => {
  const weird: ZmAccount = { id: 'acc-weird', user: 10, instrument: 424242, type: 'cash', title: 'Weird', balance: 0, inBalance: true, archive: false, changed: 1 }
  const dsWeird = withAccounts(ds, [weird])
  const impact = balanceImpact(dsWeird, [creditChange('y4', 'acc-weird', 5)])
  expect(impact).toEqual([{ accountId: 'acc-weird', accountTitle: 'Weird', currency: '', delta: 5 }])
})

// changeViews

it('changeViews: edit has before/after and no raw', () => {
  const t1 = s.getTransaction('t1')!
  const [view] = changeViews(ds, planEdit(ds, [t1], { comment: 'hi' }))
  expect(view!.raw).toBeUndefined()
  expect(view!.before?.id).toBe('t1')
  expect(view!.after?.comment).toBe('hi')
})

it('changeViews: delete has after null and raw set to the cached transaction', () => {
  const t1 = s.getTransaction('t1')!
  const [view] = changeViews(ds, planDelete([t1]))
  expect(view!.after).toBeNull()
  expect(view!.raw).toEqual(t1)
})

it('changeViews: create has before null and no raw', () => {
  const [view] = changeViews(ds, planAdd(ds, { id: 'new-2', kind: 'expense', amount: 5, accountId: 'acc-eur', date: '2026-09-20' }))
  expect(view!.before).toBeNull()
  expect(view!.after?.amount).toBe(5)
  expect(view!.raw).toBeUndefined()
})

it('changeViews: category flip from showIncome tag to showOutcome-only tag turns income into refund', () => {
  const t6 = s.getTransaction('t6')! // income tx in the fixture
  const [view] = changeViews(ds, planEdit(ds, [t6], { categoryId: 'food' })) // food: showOutcome && !showIncome
  expect(view!.before?.type).toBe('income')
  expect(view!.after?.type).toBe('refund')
})

it('changeViews: fields is the sorted set of raw field names', () => {
  const t1 = s.getTransaction('t1')!
  const [view] = changeViews(ds, planEdit(ds, [t1], { payee: 'X', comment: 'hi' }))
  expect(view!.fields).toEqual(['comment', 'merchant', 'payee'])
})

it('changeViews: fields is empty for delete', () => {
  const t1 = s.getTransaction('t1')!
  expect(changeViews(ds, planDelete([t1]))[0]!.fields).toEqual([])
})

// tableRows

it('tableRows: one row per changed field, scalar before/after', () => {
  const t1 = s.getTransaction('t1')!
  const rows = tableRows(planEdit(ds, [t1], { amount: 2500 }))
  expect(rows).toEqual([{ id: 't1', op: 'update', field: 'outcome', before: 3000, after: 2500 }])
})

it('tableRows: delete produces a single field:* row with null before/after', () => {
  const t1 = s.getTransaction('t1')!
  const rows = tableRows(planDelete([t1]))
  expect(rows).toEqual([{ id: 't1', op: 'delete', field: '*', before: null, after: null }])
})

it('tableRows: arrays format as JSON on both sides', () => {
  const t1 = s.getTransaction('t1')!
  const rows = tableRows(planEdit(ds, [t1], { categoryId: 'cafe' }))
  expect(rows).toEqual([{ id: 't1', op: 'update', field: 'tag', before: '["food"]', after: '["cafe"]' }])
})

it('tableRows: create shows before null and formats every set field, including booleans', () => {
  const rows = tableRows(planAdd(ds, { id: 'new-3', kind: 'expense', amount: 5, accountId: 'acc-eur', date: '2026-09-20', categoryId: 'food' }))
  const tagRow = rows.find(r => r.field === 'tag')!
  expect(tagRow.before).toBeNull()
  expect(tagRow.after).toBe('["food"]')
  const holdRow = rows.find(r => r.field === 'hold')!
  expect(holdRow.before).toBeNull()
  expect(holdRow.after).toBe(false)
})

it('tableRows: an unset field formats as null on both sides', () => {
  const t10 = s.getTransaction('t10')! // no category, no comment
  const rows = tableRows(planEdit(ds, [t10], { comment: '' }))
  expect(rows).toEqual([{ id: 't10', op: 'update', field: 'comment', before: null, after: null }])
})

// shellQuote

it('shellQuote: leaves already-safe strings unchanged', () => {
  expect(shellQuote('t1')).toBe('t1')
  expect(shellQuote('2026-09-01')).toBe('2026-09-01')
})

it('shellQuote: single-quotes and escapes embedded single quotes', () => {
  expect(shellQuote("it's")).toBe("'it'\\''s'")
})

it('shellQuote: a leading = is quoted even though = is otherwise a safe character (zsh EQUALS expansion)', () => {
  expect(shellQuote('=total')).toBe("'=total'")
})

it('shellQuote: = elsewhere in the string stays unquoted', () => {
  expect(shellQuote('a=b')).toBe('a=b')
  expect(shellQuote('--expect=old')).toBe('--expect=old')
})

// applyCommand

it('applyCommand: appends --apply --expect verbatim after argv, quoting only what needs it', () => {
  expect(applyCommand(['edit', 't1', '--comment', 'a b'], 'tok'))
    .toBe("zm edit t1 --comment 'a b' --apply --expect tok")
})

it('applyCommand: does not strip or special-case a value that is itself --apply (caller guarantees argv has no real --apply/--expect)', () => {
  expect(applyCommand(['edit', 't1', '--comment', '--apply'], 'tok'))
    .toBe('zm edit t1 --comment --apply --apply --expect tok')
})
