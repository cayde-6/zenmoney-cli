import { stringify } from 'yaml'
import type { Tx } from '../query/model.js'
import { NO_CATEGORY, isSpendTx, spendSign } from '../query/model.js'
import { addMonths, compareNames, localMonth, monthOf } from '../util.js'

// The window of full months to sample for `budget suggest`: N full months
// before the target month. Ends at the month before `targetMonth`, but never
// later than the month before the current one — the current month is never
// "full" yet, even when it precedes the target — and spans `months` months
// back from there.
export function suggestWindow(targetMonth: string, months: number, now: Date): { from: string; to: string } {
  const current = localMonth(now)
  const beforeTarget = addMonths(targetMonth, -1)
  const beforeCurrent = addMonths(current, -1)
  const to = beforeTarget < beforeCurrent ? beforeTarget : beforeCurrent
  return { from: addMonths(to, -(months - 1)), to }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2
  return sorted[mid]!
}

interface Pair { path: string; currency: string; value: number; nonZeroMonths: number }

// Suggests a draft budget file: for each (category, currency) pair seen over the
// window, the median of its monthly net spend, kept only when it recurred in at
// least half the months. Returns raw yaml text (header comment + `currency`/`limits`).
// `window` (see suggestWindow) is the explicit from/to of full months to sample;
// `targetMonth` only appears in the header comment.
export function suggestBudget(txs: Tx[], window: { from: string; to: string }, targetMonth: string, mainCurrency: string): string {
  const monthList: string[] = []
  for (let m = window.from; m <= window.to; m = addMonths(m, 1)) monthList.push(m)
  const months = monthList.length
  const monthSet = new Set(monthList)

  // Keyed by JSON.stringify([path, currency]) rather than a delimited string:
  // category paths can contain arbitrary characters, so any fixed separator
  // (including a NUL byte) risks colliding with real content.
  const totals = new Map<string, Map<string, number>>()
  for (const t of txs) {
    if (!isSpendTx(t)) continue
    if (t.categoryPath === NO_CATEGORY) continue
    const m = monthOf(t.date)
    if (!monthSet.has(m)) continue
    const key = JSON.stringify([t.categoryPath, t.currency])
    const byMonth = totals.get(key) ?? new Map<string, number>()
    byMonth.set(m, (byMonth.get(m) ?? 0) + spendSign(t))
    totals.set(key, byMonth)
  }

  const kept: Pair[] = []
  for (const [key, byMonth] of totals) {
    const [path, currency] = JSON.parse(key) as [string, string]
    const values = monthList.map(m => byMonth.get(m) ?? 0)
    const nonZeroMonths = values.filter(v => v !== 0).length
    if (nonZeroMonths < months / 2) continue
    // A pair whose median is <= 0 (refunds outweigh spend over the window) is
    // dropped rather than written as a negative/zero limit: the output must
    // always round-trip through parseBudgetFile (amount >= 0), and a 0 limit
    // isn't a useful suggestion anyway.
    const rawMedian = median(values)
    if (rawMedian <= 0) continue
    kept.push({ path, currency, value: Math.ceil(rawMedian), nonZeroMonths })
  }

  const byCurrencyCount = new Map<string, number>()
  for (const p of kept) byCurrencyCount.set(p.currency, (byCurrencyCount.get(p.currency) ?? 0) + 1)
  // Falls back to the main user's currency when there are no qualifying pairs
  // at all (rather than an empty string, which wouldn't even round-trip
  // through parseBudgetFile).
  let fileCurrency = mainCurrency
  let bestCount = -1
  for (const currency of [...byCurrencyCount.keys()].sort(compareNames)) {
    const count = byCurrencyCount.get(currency)!
    if (count > bestCount) {
      bestCount = count
      fileCurrency = currency
    }
  }

  const byPath = new Map<string, Pair[]>()
  for (const p of kept) {
    const arr = byPath.get(p.path) ?? []
    arr.push(p)
    byPath.set(p.path, arr)
  }

  const limits: Record<string, number | { amount: number; currency: string }> = {}
  const droppedComments: string[] = []
  const paths = [...byPath.keys()].sort(compareNames)
  for (const path of paths) {
    const pairs = byPath.get(path)!
    pairs.sort((a, b) => {
      if (b.nonZeroMonths !== a.nonZeroMonths) return b.nonZeroMonths - a.nonZeroMonths
      if (a.currency === fileCurrency && b.currency !== fileCurrency) return -1
      if (b.currency === fileCurrency && a.currency !== fileCurrency) return 1
      return compareNames(a.currency, b.currency)
    })
    const [chosen, ...dropped] = pairs
    for (const d of dropped) droppedComments.push(`# also spent: ${d.path} ${d.value} ${d.currency}`)
    limits[path] = chosen!.currency === fileCurrency ? chosen!.value : { amount: chosen!.value, currency: chosen!.currency }
  }

  const header = `# zm budget suggest: median of ${monthList[0]}..${monthList[months - 1]}, generated for ${targetMonth}\n`
  const body = stringify({ currency: fileCurrency, limits })
  const lines = body.split('\n')
  const limitsIdx = lines.findIndex(l => l.startsWith('limits:'))
  if (limitsIdx !== -1 && droppedComments.length > 0) lines.splice(limitsIdx, 0, ...droppedComments)

  return header + lines.join('\n')
}
