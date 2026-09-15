import type { Tx } from '../query/model.js'
import { addMonths, compareNames, monthOf, round2, localMonth } from '../util.js'

// The index signature makes this directly usable as a `--format table` row
// (Record<string, string | number | null>) with no cast needed.
export interface RecurringItem {
  merchant: string; categoryPath: string; currency: string
  monthsSeen: number; windowMonths: number; avgAmount: number; lastAmount: number; lastDate: string
  periodicity: 'monthly' | 'irregular'
  [field: string]: string | number | null
}

// The `months`-wide window ending at the calendar month of `now`, as YYYY-MM strings.
export function recurringWindow(months: number, now: Date): { from: string; to: string } {
  const current = localMonth(now)
  return { from: addMonths(current, -(months - 1)), to: current }
}

interface Group {
  merchant: string; categoryPath: string; currency: string
  months: Set<string>; sum: number; count: number; lastDate: string; lastAmount: number; lastId: string
}

// Consumes only `expense` txs with a non-null merchant, inside the window.
// Groups by merchant (case-insensitive, trimmed) + categoryPath + currency, so
// amounts across currencies are never mixed. Reports the most recent
// transaction's merchant spelling, amount, and date per group.
export function findRecurring(txs: Tx[], opts: { months: number; now: Date; minMonths?: number }): RecurringItem[] {
  const { months, now } = opts
  const minMonths = opts.minMonths ?? 3
  const { from, to: current } = recurringWindow(months, now)

  const windowMonths: string[] = []
  for (let i = 0; i < months; i++) windowMonths.push(addMonths(from, i))
  const requiredMonths = windowMonths.filter(m => m !== current)

  const groups = new Map<string, Group>()
  for (const t of txs) {
    if (t.type !== 'expense' || t.merchant === null) continue
    const month = monthOf(t.date)
    if (month < from || month > current) continue

    const merchant = t.merchant.trim()
    // JSON.stringify(array) rather than a delimited string: merchant/categoryPath
    // text can itself contain any separator character, which a fixed-delimiter
    // key would risk colliding on (see suggestBudget's key for the same reasoning).
    const key = JSON.stringify([merchant.toLowerCase(), t.categoryPath, t.currency])
    let g = groups.get(key)
    if (!g) {
      g = { merchant, categoryPath: t.categoryPath, currency: t.currency, months: new Set(), sum: 0, count: 0, lastDate: t.date, lastAmount: t.amount, lastId: t.id }
      groups.set(key, g)
    }
    g.months.add(month)
    g.sum += t.amount
    g.count += 1
    // Ties on the same date are broken deterministically by id (lexicographically
    // greatest), not by processing order, which would otherwise vary with the
    // order transactions happen to come out of the store.
    if (t.date > g.lastDate || (t.date === g.lastDate && t.id > g.lastId)) {
      g.lastDate = t.date
      g.lastId = t.id
      g.lastAmount = t.amount
      g.merchant = merchant
    }
  }

  const items: RecurringItem[] = []
  for (const g of groups.values()) {
    if (g.months.size < minMonths) continue
    // Monthly means "every month from this group's first appearance in the
    // window through the month before current" — not every window month.
    // A group whose data only starts partway through the window (because the
    // merchant is newer than the window, not because it's irregular) can
    // still qualify.
    const firstSeen = [...g.months].sort()[0]!
    const requiredForGroup = requiredMonths.filter(m => m >= firstSeen)
    // A group seen in fewer than 2 distinct months can never be "monthly" — a
    // single occurrence isn't a pattern, regardless of how narrow the window is.
    const periodicity: 'monthly' | 'irregular' =
      g.months.size >= 2 && requiredForGroup.every(m => g.months.has(m)) ? 'monthly' : 'irregular'
    items.push({
      merchant: g.merchant, categoryPath: g.categoryPath, currency: g.currency,
      monthsSeen: g.months.size, windowMonths: months,
      avgAmount: round2(g.sum / g.count), lastAmount: g.lastAmount, lastDate: g.lastDate,
      periodicity,
    })
  }

  return items.sort((a, b) => compareNames(a.currency, b.currency) || b.avgAmount - a.avgAmount)
}
