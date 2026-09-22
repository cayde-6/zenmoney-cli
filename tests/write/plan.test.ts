import { it, expect } from 'vitest'
import {
  isApplied, isRestricted, parseAmount, planAdd, planDelete, planEdit, planToken, UUID_RE,
  type PlannedChange,
} from '../../src/write/plan.js'
import { loadDataset, type Dataset } from '../../src/query/model.js'
import { fixtureStore } from '../helpers.js'
import type { ZmAccount, ZmTransaction } from '../../src/api/types.js'
import { ZmError } from '../../src/errors.js'

const s = fixtureStore()
const ds: Dataset = loadDataset(s)
const t1 = s.getTransaction('t1')!

it('edit keeps unknown fields and only touches set', () => {
  const [c] = planEdit(ds, [{ ...t1, extraField: 42 } as unknown as ZmTransaction], { comment: 'Higgsfield' })
  expect(c!.set).toEqual({ comment: 'Higgsfield' })
  expect((c!.next as unknown as { extraField: number }).extraField).toBe(42)
  expect(c!.next.outcome).toBe(t1.outcome)
})

it('payee clears merchant; empty payee does not', () => {
  expect(planEdit(ds, [t1], { payee: 'X' })[0]!.set).toEqual({ payee: 'X', merchant: null })
  expect(planEdit(ds, [t1], { payee: '' })[0]!.set).toEqual({ payee: null })
})

it('comment: empty string clears it, otherwise sets it verbatim', () => {
  expect(planEdit(ds, [t1], { comment: 'hi' })[0]!.set).toEqual({ comment: 'hi' })
  expect(planEdit(ds, [t1], { comment: '' })[0]!.set).toEqual({ comment: null })
})

it('categoryId sets tag to a single-element array', () => {
  expect(planEdit(ds, [t1], { categoryId: 'cafe' })[0]!.set).toEqual({ tag: ['cafe'] })
})

it('date sets date', () => {
  expect(planEdit(ds, [t1], { date: '2026-01-01' })[0]!.set).toEqual({ date: '2026-01-01' })
})

it('multiple field flags merge into one set', () => {
  expect(planEdit(ds, [t1], { comment: 'hi', payee: 'X' })[0]!.set).toEqual({ comment: 'hi', payee: 'X', merchant: null })
})

it('amount sets the outcome side of an expense', () => {
  expect(planEdit(ds, [t1], { amount: 12.5 })[0]!.set).toEqual({ outcome: 12.5 })
})

it('amount sets the income side when the target has no outcome', () => {
  const t6 = s.getTransaction('t6')! // income tx in the fixture
  expect(planEdit(ds, [t6], { amount: 7 })[0]!.set).toEqual({ income: 7 })
})

it('account sets both sides and rejects a different currency', () => {
  expect(planEdit(ds, [t1], { accountId: 'acc-partner' })[0]!.set).toEqual({ incomeAccount: 'acc-partner', outcomeAccount: 'acc-partner' })
  expect(() => planEdit(ds, [t1], { accountId: 'acc-eur' })).toThrow(/different currency/)
})

it('accountId rejects an unknown account', () => {
  expect(() => planEdit(ds, [t1], { accountId: 'nope' })).toThrow(/unknown account: nope/)
})

it('amount on a restricted tx fails the whole call, as an INVALID_ARGS error naming the restricted id', () => {
  const fx = { ...t1, id: 'fx', opOutcome: 5, opOutcomeInstrument: 1 }
  expect.assertions(5)
  try {
    planEdit(ds, [t1, fx], { amount: 1 })
  } catch (e) {
    expect(e).toBeInstanceOf(ZmError)
    expect((e as ZmError).code).toBe('INVALID_ARGS')
    expect((e as ZmError).message).toMatch(/transfer, debt, or foreign-currency/)
    expect((e as ZmError).hint).toBe('fx')
  }
  expect(planEdit(ds, [fx], { comment: 'ok' })[0]!.set).toEqual({ comment: 'ok' })
})

it('account on a restricted tx fails the whole call, as an INVALID_ARGS error naming the restricted id', () => {
  const t7 = s.getTransaction('t7')! // transfer
  expect.assertions(4)
  try {
    planEdit(ds, [t7], { accountId: 'acc-partner' })
  } catch (e) {
    expect(e).toBeInstanceOf(ZmError)
    expect((e as ZmError).code).toBe('INVALID_ARGS')
    expect((e as ZmError).message).toMatch(/transfer, debt, or foreign-currency/)
    expect((e as ZmError).hint).toBe('t7')
  }
})

it('the restricted-call error hint lists every restricted id, not just the first', () => {
  const fx1 = { ...t1, id: 'fx1', opOutcome: 5, opOutcomeInstrument: 1 }
  const t7 = s.getTransaction('t7')! // transfer
  expect.assertions(2)
  try {
    planEdit(ds, [fx1, t7, t1], { amount: 1 })
  } catch (e) {
    expect((e as ZmError).code).toBe('INVALID_ARGS')
    expect((e as ZmError).hint).toBe('fx1, t7')
  }
})

it('amount on a target with no amount at all fails the whole call, independent of the restricted check', () => {
  const zero1 = { ...t1, id: 'zero1', income: 0, outcome: 0 }
  const zero2 = { ...t1, id: 'zero2', income: 0, outcome: 0 }
  expect.assertions(3)
  try {
    planEdit(ds, [zero1, zero2, t1], { amount: 5 })
  } catch (e) {
    expect(e).toBeInstanceOf(ZmError)
    expect((e as ZmError).code).toBe('INVALID_ARGS')
    expect((e as ZmError).hint).toBe('zero1, zero2')
  }
})

it('accountId to a debt account is rejected', () => {
  expect.assertions(3)
  try {
    planEdit(ds, [t1], { accountId: 'acc-debt' })
  } catch (e) {
    expect(e).toBeInstanceOf(ZmError)
    expect((e as ZmError).code).toBe('INVALID_ARGS')
    expect((e as ZmError).message).toMatch(/cannot move a transaction to a debt account/)
  }
})

it('parseAmount accepts 33.88 and a bare integer, rejects 1e3, -1, 0, 1.234, " 5", empty, non-numeric', () => {
  expect(parseAmount('33.88', '--amount')).toBe(33.88)
  expect(parseAmount('5', '--amount')).toBe(5)
  for (const bad of ['1e3', '-1', '0', '1.234', ' 5', '', 'abc']) {
    expect(() => parseAmount(bad, '--amount')).toThrow(/invalid --amount: /)
  }
})

it('UUID_RE matches a v4-shaped id and rejects garbage', () => {
  expect(UUID_RE.test('00000000-0000-4000-8000-000000000001')).toBe(true)
  expect(UUID_RE.test('not-a-uuid')).toBe(false)
})

it('isRestricted is false for a simple same-currency expense', () => {
  expect(isRestricted(t1, ds)).toBe(false)
})

it('isRestricted detects transfer and debt rows from the fixture', () => {
  expect(isRestricted(s.getTransaction('t7')!, ds)).toBe(true) // transfer
  expect(isRestricted(s.getTransaction('t8')!, ds)).toBe(true) // debt
})

it('isRestricted flags instrument mismatch and op fields, ignores a zero op amount', () => {
  expect(isRestricted({ ...t1, incomeInstrument: 1 }, ds)).toBe(true)
  expect(isRestricted({ ...t1, opIncome: 5 }, ds)).toBe(true)
  expect(isRestricted({ ...t1, opOutcome: 5 }, ds)).toBe(true)
  expect(isRestricted({ ...t1, opIncomeInstrument: 1 }, ds)).toBe(true)
  expect(isRestricted({ ...t1, opOutcomeInstrument: 1 }, ds)).toBe(true)
  expect(isRestricted({ ...t1, opIncome: 0, opOutcome: 0 }, ds)).toBe(false)
})

it('isRestricted skips the classify rule (only) for a zero-money row', () => {
  const zero = { ...t1, income: 0, outcome: 0 }
  expect(isRestricted(zero, ds)).toBe(false)
})

it('planAdd builds a full single-currency object', () => {
  const [c] = planAdd(ds, { id: 'new-id', kind: 'expense', amount: 42.5, accountId: 'acc-pln', date: '2026-09-20' })
  expect(c!.op).toBe('create')
  expect(c!.base).toBeNull()
  expect(c!.next).toEqual({
    id: 'new-id', user: 10, date: '2026-09-20',
    income: 0, outcome: 42.5, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100,
    tag: null, merchant: null, payee: null, comment: null,
    hold: false, deleted: false, created: 0, changed: 0,
  })
  expect(c!.set).not.toHaveProperty('created')
  expect(c!.set).not.toHaveProperty('changed')
  expect(c!.set).toMatchObject({ outcome: 42.5, income: 0 })
})

it('planAdd sets tag/payee/comment when given, and defaults them to null otherwise', () => {
  const [c] = planAdd(ds, { id: 'i2', kind: 'income', amount: 1, accountId: 'acc-pln', date: '2026-09-20', categoryId: 'salary', payee: 'P', comment: 'C' })
  expect(c!.next).toMatchObject({ tag: ['salary'], payee: 'P', comment: 'C', income: 1, outcome: 0 })
})

it('planAdd normalises an empty comment/payee to null, like planEdit', () => {
  const [c] = planAdd(ds, { id: 'i3', kind: 'expense', amount: 1, accountId: 'acc-pln', date: '2026-09-20', comment: '', payee: '' })
  expect(c!.next.comment).toBeNull()
  expect(c!.next.payee).toBeNull()
})

it('planAdd rejects an unknown account', () => {
  expect(() => planAdd(ds, { id: 'x', kind: 'income', amount: 1, accountId: 'nope', date: '2026-09-20' })).toThrow(/unknown account: nope/)
})

it('planAdd rejects a debt account', () => {
  expect.assertions(3)
  try {
    planAdd(ds, { id: 'x', kind: 'expense', amount: 1, accountId: 'acc-debt', date: '2026-09-20' })
  } catch (e) {
    expect(e).toBeInstanceOf(ZmError)
    expect((e as ZmError).code).toBe('INVALID_ARGS')
    expect((e as ZmError).message).toMatch(/cannot add a transaction on a debt account/)
  }
})

it('planAdd rejects an account with no currency', () => {
  const noCur: ZmAccount = { id: 'acc-nocur', user: 10, instrument: null, type: 'cash', title: 'No currency', balance: null, inBalance: true, archive: false, changed: 1 }
  const dsNoCur: Dataset = { ...ds, accounts: new Map(ds.accounts).set('acc-nocur', noCur) }
  expect(() => planAdd(dsNoCur, { id: 'x', kind: 'income', amount: 1, accountId: 'acc-nocur', date: '2026-09-20' })).toThrow(ZmError)
})

it('planDelete marks base as deleted with an empty set', () => {
  const [c] = planDelete([t1])
  expect(c!.op).toBe('delete')
  expect(c!.id).toBe(t1.id)
  expect(c!.base).toBe(t1)
  expect(c!.next).toEqual({ ...t1, deleted: true })
  expect(c!.set).toEqual({})
})

it('token is deterministic, order-independent, and changes with base.changed and set', () => {
  const c1: PlannedChange = { op: 'update', id: 'a', base: { ...t1, id: 'a', changed: 100 }, next: t1, set: { comment: 'x' } }
  const c2: PlannedChange = { op: 'update', id: 'b', base: { ...t1, id: 'b', changed: 200 }, next: t1, set: { payee: 'y' } }
  const tok1 = planToken([c1, c2])
  expect(tok1).toHaveLength(16)
  expect(planToken([c2, c1])).toBe(tok1) // order-independent

  const c1DifferentBase: PlannedChange = { ...c1, base: { ...c1.base!, changed: 999 } }
  expect(planToken([c1DifferentBase, c2])).not.toBe(tok1)

  const c1DifferentSet: PlannedChange = { ...c1, set: { comment: 'z' } }
  expect(planToken([c1DifferentSet, c2])).not.toBe(tok1)

  // key order inside `set` must not matter (canonical JSON sorts keys)
  const c3: PlannedChange = { ...c1, set: { a: 1, b: 2 } }
  const c3ReorderedSet: PlannedChange = { ...c1, set: { b: 2, a: 1 } }
  expect(planToken([c3])).toBe(planToken([c3ReorderedSet]))

  // create: base is null, baseChanged canonicalizes as null
  const cCreate: PlannedChange = { op: 'create', id: 'new1', base: null, next: t1, set: { id: 'new1' } }
  expect(planToken([cCreate])).toHaveLength(16)
})

it('isApplied for update', () => {
  const cUpdate: PlannedChange = { op: 'update', id: 't1', base: t1, next: { ...t1, comment: 'x' }, set: { comment: 'x' } }
  expect(isApplied(cUpdate, { ...t1, comment: 'x' })).toBe(true)
  expect(isApplied(cUpdate, { ...t1, comment: 'y' })).toBe(false)
  expect(isApplied(cUpdate, null)).toBe(false)
  expect(isApplied(cUpdate, { ...t1, comment: 'x', deleted: true })).toBe(false)
})

it('isApplied for update treats null/undefined/"" in a set field as the same "nothing"', () => {
  const cUpdate: PlannedChange = { op: 'update', id: 't1', base: t1, next: { ...t1, comment: null }, set: { comment: null } }
  expect(isApplied(cUpdate, { ...t1, comment: undefined } as unknown as ZmTransaction)).toBe(true)
  expect(isApplied(cUpdate, { ...t1, comment: '' })).toBe(true)
  expect(isApplied(cUpdate, { ...t1, comment: 'still there' })).toBe(false)
})

it('isApplied for delete', () => {
  const cDelete: PlannedChange = { op: 'delete', id: 't1', base: t1, next: { ...t1, deleted: true }, set: {} }
  expect(isApplied(cDelete, null)).toBe(true)
  expect(isApplied(cDelete, { ...t1, deleted: true })).toBe(true)
  expect(isApplied(cDelete, t1)).toBe(false)
})

it('isApplied for create compares only the core money/where/what fields, tolerating a server-normalised echo', () => {
  const [c] = planAdd(ds, { id: 'i4', kind: 'expense', amount: 9.5, accountId: 'acc-pln', date: '2026-09-20', categoryId: 'food' })
  expect(isApplied(c!, null)).toBe(false)

  // exact echo plus server-assigned created/changed: applied
  expect(isApplied(c!, { ...c!.next, created: 123, changed: 123 })).toBe(true)

  // server normalises hold to null, merchant goes missing, comment comes back
  // '' instead of null: still applied — none of those are core fields, and
  // null/undefined/'' are equivalent for the ones that are compared
  const { merchant: _merchant, ...nextWithoutMerchant } = c!.next
  const echo = { ...nextWithoutMerchant, created: 123, changed: 123, hold: null, comment: '' } as unknown as ZmTransaction
  expect(isApplied(c!, echo)).toBe(true)

  // a core field actually differs: not applied
  expect(isApplied(c!, { ...c!.next, outcome: 1 })).toBe(false)
})
