import { it, expect } from 'vitest'
import { categoryPath, loadDataset, meUser, merchantLabel, NO_CATEGORY, type Dataset, type Tx } from '../../src/query/model.js'
import { parseOwnersFile } from '../../src/query/owners.js'
import { fixtureStore } from '../helpers.js'
import { Store } from '../../src/store/store.js'
import { fixtureDiff } from '../fixtures/diff.js'
import type { ZmTransaction } from '../../src/api/types.js'

const ds = () => loadDataset(fixtureStore())
const byId = (id: string) => ds().txs.find(t => t.id === id)!

it('excludes deleted', () => { expect(ds().txs.some(t => t.id === 't9')).toBe(false); expect(ds().txs).toHaveLength(22) })
it('classifies all types', () => {
  expect(byId('t1')).toMatchObject({ type: 'expense', amount: 3000, currency: 'PLN', categoryPath: 'Groceries', merchant: 'FreshMart', ownerId: 10 })
  expect(byId('t2')).toMatchObject({ type: 'expense', ownerId: 11, merchant: null })
  expect(byId('t2')).toMatchObject({ payee: 'CornerShop' }) // payee-only tx: merchant stays null, payee is untouched
  expect(byId('t3')).toMatchObject({ categoryPath: 'Food/Cafe', topCategoryId: 'eat', currency: 'EUR' })
  expect(byId('t5')).toMatchObject({ type: 'refund', amount: 500, currency: 'PLN' })
  expect(byId('t6')).toMatchObject({ type: 'income', amount: 4200, currency: 'EUR' })
  expect(byId('t7')).toMatchObject({ type: 'transfer', amount: 100, currency: 'EUR', accountId: 'acc-eur', counterpart: { accountId: 'acc-pln', amount: 11700, currency: 'PLN', accountTitle: 'Card PLN' } })
  expect(byId('t8')).toMatchObject({ type: 'debt', amount: 50, currency: 'EUR', accountId: 'acc-eur', counterpart: { accountId: 'acc-debt' } })
  expect(byId('t10')).toMatchObject({ type: 'expense', categoryPath: 'Uncategorized', categoryId: null })
})
it('sorts by date desc', () => { expect(ds().txs[0]!.id).toBe('t14') })
// classify()'s own tag lookup (distinct from loadDataset's separate
// catId computation): every fixture income/refund transaction happens to
// carry a tag, so classify's `t.tag?.[0] ?? null` / `firstTagId ? ... :
// undefined` branches for a MISSING tag are otherwise never exercised — an
// untagged income transaction must still classify as 'income', not throw or
// misclassify as 'refund'.
it('classify: an income transaction with no tag at all classifies as income (not refund)', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const untaggedIncome: ZmTransaction = {
    id: 'tNoTagIncome', user: 10, date: '2026-09-01', income: 25, outcome: 0, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: null, merchant: null, payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(untaggedIncome)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  expect(loadDataset(s).txs.find(t => t.id === 'tNoTagIncome')!.type).toBe('income')
})
// loadDataset's .sort() has an id-ascending tie-break for same-date
// transactions (model.ts:209), but it's unreachable through any real call
// path: the only source feeding that sort is store.all('transaction'),
// which always returns rows ORDER BY id (store.ts), and Array#sort is
// stable in V8 — so same-date transactions always arrive already
// id-ascending, regardless of insertion order into the diff. Deleting the
// tie-break entirely (verified against a scratch copy) leaves the whole
// suite green, so no test is kept for it here; see the code review that
// flagged this (mutation testing round) for context.
it('finds me', () => { expect(meUser(ds()).login).toBe('owner') })
it('with no owners.yaml, ownerNames is null, ownerOf is empty, and every Tx.owner is null', () => {
  const d = ds()
  expect(d.ownerNames).toBeNull()
  expect(d.ownerOf.size).toBe(0)
  expect(d.txs.every(t => t.owner === null)).toBe(true)
})
it('with owners.yaml, Tx.owner is the owner of the primary-side account, and Dataset carries ownerNames/ownerOf', () => {
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["Card PLN"]\n  sam:\n    accounts: ["acc-partner"]\n', 'owners.yaml')
  const d = loadDataset(fixtureStore(), file)
  expect(d.ownerNames).toEqual(['alex', 'sam'])
  expect(d.ownerOf.get('acc-pln')).toBe('alex')
  expect(d.ownerOf.get('acc-partner')).toBe('sam')
  expect(d.txs.find(t => t.id === 't1')!.owner).toBe('alex') // primary account acc-pln
  expect(d.txs.find(t => t.id === 't2')!.owner).toBe('sam') // primary account acc-partner
  expect(d.txs.find(t => t.id === 't3')!.owner).toBeNull() // primary account acc-eur, unassigned
})
// Review round follow-up item 1: `zm owners` needs conflictMode 'collect'
// forwarded all the way through loadDataset to matchOwners, so it can
// report a non-archived conflict as data instead of the command failing.
it('loadDataset forwards conflictMode "collect" to matchOwners: a non-archived conflict is reported via ownerConflicts, not thrown', () => {
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["Card"]\n  sam:\n    accounts: ["PLN"]\n', 'owners.yaml')
  const d = loadDataset(fixtureStore(), file, 'owners.yaml', 'collect')
  expect(d.ownerConflicts).toEqual([{ id: 'acc-pln', title: 'Card PLN', owners: ['alex', 'sam'] }])
  expect(d.ownerOf.has('acc-pln')).toBe(false)
  expect(d.txs.find(t => t.id === 't1')!.owner).toBeNull() // primary account acc-pln, unassigned due to conflict
})
it('loadDataset defaults to conflictMode "throw" (every command except zm owners)', () => {
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["Card"]\n  sam:\n    accounts: ["PLN"]\n', 'owners.yaml')
  expect(() => loadDataset(fixtureStore(), file)).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
it('normalises a whitespace-only comment to null', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const whitespaceComment: ZmTransaction = {
    id: 'tWS', user: 10, date: '2026-09-01', income: 0, outcome: 5, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: null, merchant: null, payee: null, comment: '   ',
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(whitespaceComment)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  expect(loadDataset(s).txs.find(t => t.id === 'tWS')!.comment).toBeNull()
})
it('normalises a whitespace-only payee and originalPayee to null', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const whitespaceFields: ZmTransaction = {
    id: 'tWSPayee', user: 10, date: '2026-09-01', income: 0, outcome: 5, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: null, merchant: null, payee: '   ', comment: null,
    deleted: false, created: 1780000000, changed: 1780000000, originalPayee: '\t',
  }
  diff.transaction!.push(whitespaceFields)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const tx = loadDataset(s).txs.find(t => t.id === 'tWSPayee')!
  expect(tx.payee).toBeNull()
  expect(tx.originalPayee).toBeNull()
})
it('normalises a resolved merchant whose title is whitespace-only to null', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  diff.merchant!.push({ id: 'm-blank', user: 10, title: '   ', changed: 1780000000 })
  const whitespaceMerchant: ZmTransaction = {
    id: 'tWSMerchant', user: 10, date: '2026-09-01', income: 0, outcome: 5, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: null, merchant: 'm-blank', payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(whitespaceMerchant)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  expect(loadDataset(s).txs.find(t => t.id === 'tWSMerchant')!.merchant).toBeNull()
})
it('keeps payee alongside a resolved merchant, rather than dropping it', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const both: ZmTransaction = {
    id: 'tBoth', user: 10, date: '2026-09-01', income: 0, outcome: 5, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: null, merchant: 'm-fresh', payee: 'Distinct Payee', comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(both)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const tx = loadDataset(s).txs.find(t => t.id === 'tBoth')!
  expect(tx.merchant).toBe('FreshMart')
  expect(tx.payee).toBe('Distinct Payee')
})
it('excludes a transaction with income === 0 and outcome === 0 (carries no money)', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const zeroTx: ZmTransaction = {
    id: 'tZero', user: 10, date: '2026-09-01', income: 0, outcome: 0, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: null, merchant: null, payee: null, comment: 'placeholder',
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(zeroTx)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  expect(loadDataset(s).txs.some(t => t.id === 'tZero')).toBe(false)
})
it('a tag whose parent id is missing from the tag map is treated as top-level', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  diff.tag!.push({ id: 'orphan', user: 10, title: 'Orphan Category', parent: 'no-such-parent', showIncome: false, showOutcome: true, changed: 0 })
  const orphanTx: ZmTransaction = {
    id: 'tOrphan', user: 10, date: '2026-09-01', income: 0, outcome: 42, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: ['orphan'], merchant: null, payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(orphanTx)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const tx = loadDataset(s).txs.find(t => t.id === 'tOrphan')!
  // Consistent with categoryPath (and `categories --tree`), a dangling parent
  // reference falls back to the tag's own id/title rather than the unresolved
  // parent id leaking through as topCategoryId.
  expect(tx.topCategoryId).toBe('orphan')
  expect(tx.categoryPath).toBe('Orphan Category')
})
// categoryPath is exported and called directly by callers like
// filters.ts/analytics beyond loadDataset's own (already-validated) catId —
// it must degrade to NO_CATEGORY for an id that resolves to nothing, not
// throw or return an empty path.
it('categoryPath returns NO_CATEGORY for a tag id absent from the tag map', () => {
  expect(categoryPath('no-such-tag-at-all', ds().tags)).toBe(NO_CATEGORY)
})
it('a transaction whose tag id is not in the tag map is treated as uncategorized (A-16)', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const missingTagTx: ZmTransaction = {
    id: 'tMissingTag', user: 10, date: '2026-09-01', income: 0, outcome: 7, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: ['no-such-tag-id'], merchant: null, payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(missingTagTx)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const tx = loadDataset(s).txs.find(t => t.id === 'tMissingTag')!
  expect(tx.categoryId).toBeNull()
  expect(tx.topCategoryId).toBeNull()
  expect(tx.categoryPath).toBe('Uncategorized')
})
// A-19 (and review round item 2): `hold` and `originalPayee` are surfaced on
// `Tx` (useful for agents — "this expense hasn't settled yet"), but neither
// affects classification — a hold transaction is counted exactly like a
// normal one. The other raw op* fields (opIncome/opOutcome/
// opIncomeInstrument/opOutcomeInstrument) stay typed-only on ZmTransaction
// (preserved in the cache's raw json) and are deliberately NOT surfaced on
// Tx / in `zm tx` output.
it('a transaction with hold: true is classified/counted like a normal one, and hold/originalPayee are surfaced on Tx', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const holdTx: ZmTransaction = {
    id: 'tHold', user: 10, date: '2026-09-01', income: 0, outcome: 15, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 100, outcomeInstrument: 100, tag: ['food'], merchant: null, payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
    hold: true, opIncome: 0, opOutcome: 15, opIncomeInstrument: 100, opOutcomeInstrument: 100, originalPayee: 'Raw Payee',
  }
  diff.transaction!.push(holdTx)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const tx = loadDataset(s).txs.find(t => t.id === 'tHold')!
  expect(tx.type).toBe('expense')
  expect(tx.amount).toBe(15)
  expect(tx.hold).toBe(true)
  expect(tx.originalPayee).toBe('Raw Payee')
  expect(tx).not.toHaveProperty('opIncome')
  expect(tx).not.toHaveProperty('opOutcome')
})
it('hold defaults to false and originalPayee to null when the raw transaction has neither', () => {
  const ds = loadDataset(fixtureStore())
  const tx = ds.txs.find(t => t.id === 't1')!
  expect(tx.hold).toBe(false)
  expect(tx.originalPayee).toBeNull()
})
// t8 in the fixture has the debt account on the INCOME side (outcomeAccount
// is the ordinary acc-eur). This covers the other half of loadDataset's debt
// branch: the debt account on the OUTCOME side, where the primary side must
// flip to the income side instead.
it('debt: when the debt account is on the outcome side, the primary side is the income account', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const debtOnOutcome: ZmTransaction = {
    id: 'tDebtOutcome', user: 10, date: '2026-09-01', income: 60, outcome: 60,
    incomeAccount: 'acc-eur', outcomeAccount: 'acc-debt',
    incomeInstrument: 100 /* PLN */, outcomeInstrument: 100, tag: null, merchant: null, payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(debtOnOutcome)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const tx = loadDataset(s).txs.find(t => t.id === 'tDebtOutcome')!
  expect(tx.type).toBe('debt')
  expect(tx.accountId).toBe('acc-eur')
  expect(tx.amount).toBe(60)
  expect(tx.counterpart).toMatchObject({ accountId: 'acc-debt', amount: 60 })
})
it('transfer: a dangling counterpart account/instrument id falls back to the raw id and empty currency', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const ghostTransfer: ZmTransaction = {
    id: 'tGhostTransfer', user: 10, date: '2026-09-01',
    income: 40, outcome: 40, incomeAccount: 'acc-ghost', outcomeAccount: 'acc-eur',
    incomeInstrument: 12345, outcomeInstrument: 3 /* EUR */, tag: null, merchant: null, payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(ghostTransfer)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const tx = loadDataset(s).txs.find(t => t.id === 'tGhostTransfer')!
  expect(tx.type).toBe('transfer')
  expect(tx.counterpart).toMatchObject({ accountId: 'acc-ghost', accountTitle: 'acc-ghost', currency: '' })
})
it('debt (debt account on outcome side): an unknown outcome instrument id falls back to empty counterpart currency', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const debtUnknownInstrument: ZmTransaction = {
    id: 'tDebtUnknownInstrument', user: 10, date: '2026-09-01',
    income: 20, outcome: 20, incomeAccount: 'acc-eur', outcomeAccount: 'acc-debt',
    incomeInstrument: 3 /* EUR */, outcomeInstrument: 54321, tag: null, merchant: null, payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(debtUnknownInstrument)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const tx = loadDataset(s).txs.find(t => t.id === 'tDebtUnknownInstrument')!
  expect(tx.type).toBe('debt')
  expect(tx.counterpart).toMatchObject({ accountId: 'acc-debt', accountTitle: 'Debts', currency: '' })
})
it('debt (debt account on income side): an unknown income instrument id falls back to empty counterpart currency', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const debtIncomeUnknownInstrument: ZmTransaction = {
    id: 'tDebtIncomeUnknownInstrument', user: 10, date: '2026-09-01',
    income: 30, outcome: 30, incomeAccount: 'acc-debt', outcomeAccount: 'acc-eur',
    incomeInstrument: 98765, outcomeInstrument: 3 /* EUR */, tag: null, merchant: null, payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(debtIncomeUnknownInstrument)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const tx = loadDataset(s).txs.find(t => t.id === 'tDebtIncomeUnknownInstrument')!
  expect(tx.type).toBe('debt')
  expect(tx.accountId).toBe('acc-eur')
  expect(tx.counterpart).toMatchObject({ accountId: 'acc-debt', accountTitle: 'Debts', currency: '' })
})
// The primary-side fallbacks (accountTitle/currency/ownerId) apply to any tx
// type, not just transfer/debt counterparts — a plain expense referencing an
// account (and instrument) id that no longer exists in the cache must still
// produce a usable Tx instead of throwing, falling back to the raw account
// id as the title, an empty currency, and the raw ZenMoney tx user as owner.
it('expense: an unknown primary account/instrument id falls back to the raw id, empty currency, and the raw tx user', () => {
  const s = Store.memory()
  const diff = fixtureDiff()
  const ghostExpense: ZmTransaction = {
    id: 'tGhostExpense', user: 77, date: '2026-09-01', income: 0, outcome: 15,
    incomeAccount: 'acc-ghost-2', outcomeAccount: 'acc-ghost-2',
    incomeInstrument: 11111, outcomeInstrument: 11111, tag: null, merchant: null, payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(ghostExpense)
  s.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const tx = loadDataset(s).txs.find(t => t.id === 'tGhostExpense')!
  expect(tx.type).toBe('expense')
  expect(tx.accountId).toBe('acc-ghost-2')
  expect(tx.accountTitle).toBe('acc-ghost-2')
  expect(tx.currency).toBe('')
  expect(tx.ownerId).toBe(77)
})
it('meUser throws NO_CACHE when the dataset has no main user', () => {
  const noMainUser: Dataset = {
    users: [{ id: 1, login: 'x', currency: 3, parent: 99, changed: 0 }],
    accounts: new Map(), tags: new Map(), instruments: new Map(), txs: [],
    ownerNames: null, ownerOf: new Map(), ownersPath: null, ownerWarnings: [], ownerConflicts: [],
  }
  expect(() => meUser(noMainUser)).toThrow(expect.objectContaining({ code: 'NO_CACHE' }))
})

// merchantLabel is the shared fallback (merchant -> payee -> originalPayee ->
// comment) used by both `zm recurring` and `zm spend --by merchant`, so real
// ZenMoney data with no merchant/payee at all (only a free-form comment) is
// still attributed to something instead of being silently dropped.
function labelTx(over: Partial<Tx>): Tx {
  return {
    id: 'x', date: '2026-09-01', type: 'expense', amount: 10, currency: 'EUR',
    accountId: 'a', accountTitle: 'a', ownerId: 1, owner: null, categoryId: null, topCategoryId: null,
    categoryPath: 'Uncategorized', merchant: null, payee: null, comment: null, hold: false, originalPayee: null, ...over,
  }
}
it('merchantLabel prefers merchant, then payee, then originalPayee, then comment', () => {
  expect(merchantLabel(labelTx({ merchant: 'M', payee: 'P', originalPayee: 'O', comment: 'C' }))).toEqual({ label: 'M', source: 'merchant' })
  expect(merchantLabel(labelTx({ merchant: null, payee: 'P', originalPayee: 'O', comment: 'C' }))).toEqual({ label: 'P', source: 'payee' })
  expect(merchantLabel(labelTx({ merchant: null, payee: null, originalPayee: 'O', comment: 'C' }))).toEqual({ label: 'O', source: 'originalPayee' })
  expect(merchantLabel(labelTx({ merchant: null, payee: null, originalPayee: null, comment: 'C' }))).toEqual({ label: 'C', source: 'comment' })
})
it('merchantLabel returns null when merchant, payee, originalPayee, and comment are all empty or whitespace-only', () => {
  expect(merchantLabel(labelTx({}))).toBeNull()
  expect(merchantLabel(labelTx({ merchant: '  ', payee: '\t', originalPayee: '', comment: '   ' }))).toBeNull()
})
it('merchantLabel trims the winning field', () => {
  expect(merchantLabel(labelTx({ comment: '  Music Plus  ' }))).toEqual({ label: 'Music Plus', source: 'comment' })
})
