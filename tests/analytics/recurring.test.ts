import { it, expect } from 'vitest'
import { loadDataset } from '../../src/query/model.js'
import { findRecurring, recurringWindow } from '../../src/analytics/recurring.js'
import { fixtureStore } from '../helpers.js'
import { Store } from '../../src/store/store.js'
import { fixtureDiff } from '../fixtures/diff.js'
import type { ZmTransaction } from '../../src/api/types.js'

const ds = loadDataset(fixtureStore())
const now = new Date('2026-09-20T12:00:00')
const netflixTx = ds.txs.find(t => t.merchant === 'Netflix')!

it('finds monthly subscription', () => {
  // Netflix is only seen from 06 onward (no data in 04/05, the earlier part of
  // this 6-month window) but is present in every month from its first
  // appearance through the month before now (06..08, 09 being the current,
  // possibly-incomplete month) — so it still counts as monthly.
  expect(findRecurring(ds.txs, { months: 6, now })).toEqual([
    { merchant: 'Netflix', source: 'merchant', categoryPath: 'Subscriptions', currency: 'EUR', monthsSeen: 4, windowMonths: 6, avgAmount: 12, lastAmount: 12, lastDate: '2026-09-15', periodicity: 'monthly' },
  ])
})
it('irregular when a month is skipped between first-seen and the month before current', () => {
  const netflixTx = ds.txs.find(t => t.merchant === 'Netflix')!
  const skipped = [
    { ...netflixTx, id: 'z1', date: '2026-06-15' },
    { ...netflixTx, id: 'z2', date: '2026-08-15' }, // 07 is skipped
    { ...netflixTx, id: 'z3', date: '2026-09-15' },
  ]
  expect(findRecurring(skipped, { months: 6, now })[0]!.periodicity).toBe('irregular')
})
it('monthly when present in every window month except current', () => {
  expect(findRecurring(ds.txs, { months: 4, now })[0]!.periodicity).toBe('monthly')
  expect(findRecurring(ds.txs, { months: 4, now: new Date('2026-10-02T12:00:00') })[0]!.periodicity).toBe('monthly')
})
it('drops groups below minMonths and outside window', () => {
  expect(findRecurring(ds.txs, { months: 2, now })).toEqual([])
  expect(findRecurring(ds.txs, { months: 6, now, minMonths: 5 })).toEqual([])
})
it('merges merchant spellings case-insensitively/trimmed, using the latest spelling', () => {
  const early = { ...netflixTx, id: 'x1', date: '2026-07-10', merchant: ' Netflix ' }
  const late = { ...netflixTx, id: 'x2', date: '2026-08-20', merchant: 'netflix' }
  expect(findRecurring([early, late], { months: 2, now: new Date('2026-08-25T12:00:00'), minMonths: 2 })).toEqual([
    {
      merchant: 'netflix', source: 'merchant', categoryPath: netflixTx.categoryPath, currency: netflixTx.currency,
      monthsSeen: 2, windowMonths: 2, avgAmount: netflixTx.amount, lastAmount: netflixTx.amount,
      lastDate: '2026-08-20', periodicity: 'monthly',
    },
  ])
})
// review round item 2: findRecurring and spend --by merchant must group by
// the same normalized key regardless of which fallback field (merchant,
// payee, originalPayee, comment) supplied the label.
it('merges comment-derived spellings case-insensitively/trimmed too, same as a merchant field would', () => {
  const base = { ...netflixTx, merchant: null, payee: null, originalPayee: null }
  const early = { ...base, id: 'c1', date: '2026-07-10', comment: 'Netflix' }
  const late = { ...base, id: 'c2', date: '2026-08-20', comment: 'netflix ' }
  const result = findRecurring([early, late], { months: 2, now: new Date('2026-08-25T12:00:00'), minMonths: 2 })
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ merchant: 'netflix', source: 'comment' })
})
it('same merchant in two currencies produces two groups, sorted currency asc', () => {
  // USD is inserted first and has the larger avg: with the sort comparator's
  // currency clause removed, both insertion order and the amount-desc
  // tiebreaker would put USD before EUR, so this only passes with the
  // currency-first sort actually applied.
  const usd = { ...netflixTx, id: 'y2', date: '2026-05-05', currency: 'USD', amount: 20 }
  const eur = { ...netflixTx, id: 'y1', date: '2026-05-05', currency: 'EUR', amount: 5 }
  const result = findRecurring([usd, eur], { months: 1, now: new Date('2026-05-20T12:00:00'), minMonths: 1 })
  expect(result).toHaveLength(2)
  expect(result.map(r => r.currency)).toEqual(['EUR', 'USD'])
})
it('grouping key does not collide when merchant/category text contains the old "|" separator', () => {
  // Old key: `${merchant}|${categoryPath}|${currency}`. merchant "a" + categoryPath
  // "b|c" and merchant "a|b" + categoryPath "c" both produced the literal string
  // "a|b|c|EUR", merging two unrelated groups. JSON.stringify([...]) must keep them apart.
  const base = { ...ds.txs[0]!, currency: 'EUR' }
  const g1 = { ...base, id: 'k1', date: '2026-08-01', merchant: 'a', categoryPath: 'b|c' }
  const g2 = { ...base, id: 'k2', date: '2026-08-02', merchant: 'a|b', categoryPath: 'c' }
  const result = findRecurring([g1, g2], { months: 1, now: new Date('2026-08-20T12:00:00'), minMonths: 1 })
  expect(result).toHaveLength(2)
})
it('window crosses a year boundary', () => {
  expect(recurringWindow(3, new Date('2027-01-10T12:00:00'))).toEqual({ from: '2026-11', to: '2027-01' })
})
it('a group seen in only one distinct month is never monthly, even with minMonths 1', () => {
  const single = [{ ...netflixTx, id: 'o1', date: '2026-09-05' }]
  const result = findRecurring(single, { months: 1, now, minMonths: 1 })
  expect(result).toHaveLength(1)
  expect(result[0]!.periodicity).toBe('irregular')
})
it('ties on the latest date break deterministically by id (lexicographically greatest wins)', () => {
  // Both share date 2026-08-20; 'm9' > 'm10' lexicographically ('9' > '1').
  // Feeding the higher id first and the lower id last means a naive
  // "last one processed wins" tie-break would pick the wrong one.
  const higher = { ...netflixTx, id: 'm9', date: '2026-08-20', amount: 10, merchant: 'Netflix' }
  const lower = { ...netflixTx, id: 'm10', date: '2026-08-20', amount: 20, merchant: 'netflix' }
  const result = findRecurring([higher, lower], { months: 1, now: new Date('2026-08-25T12:00:00'), minMonths: 1 })
  expect(result[0]).toMatchObject({ lastAmount: 10, merchant: 'Netflix' })
})
// Real ZenMoney data: a subscription with no merchant match and no
// payee/originalPayee at all — the only text is the free-form comment (fixture
// txs t20..t23, dated well outside every other test's window so they can only
// show up here). Regression for findRecurring only ever considering `merchant`.
it('falls back to comment when merchant, payee, and originalPayee are all null', () => {
  const now2 = new Date('2026-03-20T12:00:00')
  expect(findRecurring(ds.txs, { months: 4, now: now2 })).toEqual([
    {
      merchant: 'Music Plus', source: 'comment', categoryPath: 'Music', currency: 'PLN',
      monthsSeen: 4, windowMonths: 4, avgAmount: 1500, lastAmount: 1500, lastDate: '2026-03-15',
      periodicity: 'monthly',
    },
  ])
})
// loadDataset regression (review round item 1): a payee-only transaction
// (ZenMoney found no merchant match) used to fold `payee` into `Tx.merchant`,
// so findRecurring reported source: 'merchant' for text that was actually a
// raw payee. Built through a real Store + fixtureDiff (not a hand-set Tx) so
// this exercises loadDataset itself, not just merchantLabel's fallback order.
it('loadDataset: a payee-only transaction (no merchant match) surfaces as source "payee", not "merchant"', () => {
  const store = Store.memory()
  const diff = fixtureDiff()
  const dates = ['2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15']
  for (const [i, date] of dates.entries()) {
    const t: ZmTransaction = {
      id: `tPayeeOnly${i}`, user: 10, date, income: 0, outcome: 25,
      incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln', incomeInstrument: 100, outcomeInstrument: 100,
      tag: ['subs'], merchant: null, payee: 'GymPass', comment: null,
      deleted: false, created: 1780000000, changed: 1780000000,
    }
    diff.transaction!.push(t)
  }
  store.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  const localDs = loadDataset(store)
  const result = findRecurring(localDs.txs, { months: 4, now: new Date('2026-09-20T12:00:00') })
  const item = result.find(r => r.merchant === 'GymPass')
  expect(item).toMatchObject({ merchant: 'GymPass', source: 'payee', periodicity: 'monthly' })
})
it('the fallback chain prefers payee and originalPayee over comment when present', () => {
  const base = { ...netflixTx, categoryPath: 'Music', currency: 'PLN' }
  const viaPayee = { ...base, id: 'f1', date: '2026-01-10', merchant: null, payee: 'PayeeWins', originalPayee: 'OrigLoses', comment: 'CommentLoses' }
  const viaOriginalPayee = { ...base, id: 'f2', date: '2026-02-10', merchant: null, payee: null, originalPayee: 'OrigWins', comment: 'CommentLoses' }
  const r1 = findRecurring([viaPayee], { months: 1, now: new Date('2026-01-20T12:00:00'), minMonths: 1 })
  const r2 = findRecurring([viaOriginalPayee], { months: 1, now: new Date('2026-02-20T12:00:00'), minMonths: 1 })
  expect(r1[0]).toMatchObject({ merchant: 'PayeeWins', source: 'payee' })
  expect(r2[0]).toMatchObject({ merchant: 'OrigWins', source: 'originalPayee' })
})
