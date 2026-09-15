import type { ZmDiff, ZmTransaction } from '../../src/api/types.js'

const RUB = 2, EUR = 3, PLN = 100
let n = 0
function base(date: string, over: Partial<ZmTransaction>): ZmTransaction {
  n++
  return {
    id: `t${n}`, user: 10, date, income: 0, outcome: 0, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: PLN, outcomeInstrument: PLN, tag: null, merchant: null, payee: null, comment: null,
    deleted: false, created: 1780000000, changed: 1780000000, ...over,
  }
}
const inst = (acc: string) => (acc === 'acc-eur' || acc === 'acc-debt' ? EUR : PLN)
function expense(date: string, acc: string, amount: number, tag: string | null, over: Partial<ZmTransaction> = {}) {
  return base(date, { outcome: amount, outcomeAccount: acc, incomeAccount: acc, outcomeInstrument: inst(acc), incomeInstrument: inst(acc), tag: tag ? [tag] : null, ...over })
}
function income(date: string, acc: string, amount: number, tag: string, over: Partial<ZmTransaction> = {}) {
  return base(date, { income: amount, incomeAccount: acc, outcomeAccount: acc, incomeInstrument: inst(acc), outcomeInstrument: inst(acc), tag: [tag], ...over })
}

export function fixtureDiff(): ZmDiff {
  n = 0
  const c = 1780000000
  return {
    serverTimestamp: 1789000000,
    instrument: [
      { id: 1, title: 'US Dollar', shortTitle: 'USD', symbol: '$', rate: 80, changed: c },
      { id: RUB, title: 'Russian Ruble', shortTitle: 'RUB', symbol: '₽', rate: 1, changed: c },
      { id: EUR, title: 'Euro', shortTitle: 'EUR', symbol: '€', rate: 90, changed: c },
      { id: PLN, title: 'Polish Zloty', shortTitle: 'PLN', symbol: 'zł', rate: 20, changed: c },
    ],
    user: [
      { id: 10, login: 'owner', currency: EUR, parent: null, changed: c },
      { id: 11, login: 'partner', currency: EUR, parent: 10, changed: c },
    ],
    account: [
      { id: 'acc-pln', user: 10, instrument: PLN, type: 'ccard', title: 'Card PLN', balance: 50000, inBalance: true, archive: false, changed: c },
      { id: 'acc-eur', user: 10, instrument: EUR, type: 'cash', title: 'Cash EUR', balance: 3000, inBalance: true, archive: false, changed: c },
      { id: 'acc-partner', user: 11, instrument: PLN, type: 'ccard', title: 'Card Partner', balance: 90000, inBalance: true, archive: false, changed: c },
      { id: 'acc-debt', user: 10, instrument: EUR, type: 'debt', title: 'Debts', balance: 0, inBalance: false, archive: false, changed: c },
      { id: 'acc-old', user: 10, instrument: EUR, type: 'cash', title: 'Old Cash', balance: 0, inBalance: true, archive: true, changed: c },
    ],
    tag: [
      { id: 'food', user: 10, title: 'Groceries', parent: null, showIncome: false, showOutcome: true, changed: c },
      { id: 'eat', user: 10, title: 'Food', parent: null, showIncome: false, showOutcome: true, changed: c },
      { id: 'cafe', user: 10, title: 'Cafe ', parent: 'eat', showIncome: false, showOutcome: true, changed: c },
      { id: 'health', user: 10, title: 'Health', parent: null, showIncome: false, showOutcome: true, changed: c },
      { id: 'dent', user: 10, title: 'Dentist', parent: 'health', showIncome: false, showOutcome: true, changed: c },
      { id: 'salary', user: 10, title: 'Salary', parent: null, showIncome: true, showOutcome: false, changed: c },
      { id: 'subs', user: 10, title: 'Subscriptions', parent: null, showIncome: false, showOutcome: true, changed: c },
    ],
    merchant: [
      { id: 'm-fresh', user: 10, title: 'FreshMart', changed: c },
      { id: 'm-netflix', user: 10, title: 'Netflix', changed: c },
    ],
    transaction: [
      expense('2026-09-02', 'acc-pln', 3000, 'food', { merchant: 'm-fresh' }),          // t1
      expense('2026-09-05', 'acc-partner', 2000, 'food', { payee: 'CornerShop', user: 11 }), // t2 owner partner
      expense('2026-09-03', 'acc-eur', 20, 'cafe', { payee: 'Cafe X' }),               // t3
      expense('2026-09-12', 'acc-pln', 80000, 'dent'),                                   // t4
      income('2026-09-10', 'acc-pln', 500, 'food', { merchant: 'm-fresh' }),           // t5 refund
      income('2026-09-01', 'acc-eur', 4200, 'salary'),                                   // t6 income
      base('2026-09-04', { outcome: 100, outcomeAccount: 'acc-eur', outcomeInstrument: EUR, income: 11700, incomeAccount: 'acc-pln', incomeInstrument: PLN }), // t7 transfer
      base('2026-09-06', { outcome: 50, outcomeAccount: 'acc-eur', outcomeInstrument: EUR, income: 50, incomeAccount: 'acc-debt', incomeInstrument: EUR }),    // t8 debt
      expense('2026-09-07', 'acc-pln', 999, 'food', { deleted: true }),                  // t9 deleted
      expense('2026-09-08', 'acc-eur', 10, null),                                        // t10 no category
      expense('2026-06-15', 'acc-eur', 12, 'subs', { merchant: 'm-netflix' }),         // t11
      expense('2026-07-15', 'acc-eur', 12, 'subs', { merchant: 'm-netflix' }),         // t12
      expense('2026-08-15', 'acc-eur', 12, 'subs', { merchant: 'm-netflix' }),         // t13
      expense('2026-09-15', 'acc-eur', 12, 'subs', { merchant: 'm-netflix' }),         // t14
      expense('2026-06-10', 'acc-pln', 40000, 'food'),                                   // t15
      expense('2026-07-10', 'acc-pln', 50000, 'food'),                                   // t16
      expense('2026-08-10', 'acc-pln', 45000, 'food'),                                   // t17
      expense('2026-08-20', 'acc-eur', 30, 'cafe'),                                     // t18
      expense('2026-09-09', 'acc-pln', 5000, 'health'),                                 // t19 parent's own op
    ],
    deletion: [],
  }
}
