import type { Tx } from '../query/model.js'
import { isSpendTx, spendSign } from '../query/model.js'
import { ZmError } from '../errors.js'
import { monthRange, round1, round2 } from '../util.js'

export interface CompareRow { key: string; currency: string; period: number; vs: number; diff: number; diffPct: number | null }

const MONTH_RE = /^\d{4}-\d{2}$/
const RANGE_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/

export function parsePeriod(p: string): { from: string; to: string } {
  if (MONTH_RE.test(p)) {
    const month = Number(p.slice(5, 7))
    if (month < 1 || month > 12) throw new ZmError('INVALID_ARGS', `invalid month: ${p}`, 'use YYYY-MM')
    return monthRange(p)
  }
  const range = RANGE_RE.exec(p)
  if (range) return { from: range[1]!, to: range[2]! }
  throw new ZmError('INVALID_ARGS', `invalid period: ${p}`, 'use YYYY-MM or YYYY-MM-DD..YYYY-MM-DD')
}

// Aggregates spend by `key` ('total' or categoryPath) and then by currency.
function aggregate(txs: Tx[], by: 'total' | 'category'): Map<string, Map<string, number>> {
  const byKey = new Map<string, Map<string, number>>()
  for (const t of txs) {
    if (!isSpendTx(t)) continue
    const key = by === 'total' ? 'total' : t.categoryPath
    const byCurrency = byKey.get(key) ?? new Map<string, number>()
    byCurrency.set(t.currency, (byCurrency.get(t.currency) ?? 0) + spendSign(t))
    byKey.set(key, byCurrency)
  }
  return byKey
}

export function compare(periodTxs: Tx[], vsTxs: Tx[], by: 'total' | 'category'): CompareRow[] {
  const periodAgg = aggregate(periodTxs, by)
  const vsAgg = aggregate(vsTxs, by)
  const keys = new Set([...periodAgg.keys(), ...vsAgg.keys()])

  const rows: CompareRow[] = []
  for (const key of keys) {
    const periodByCurrency = periodAgg.get(key)
    const vsByCurrency = vsAgg.get(key)
    const currencies = new Set([...(periodByCurrency?.keys() ?? []), ...(vsByCurrency?.keys() ?? [])])
    for (const currency of currencies) {
      const period = round2(periodByCurrency?.get(currency) ?? 0)
      const vs = round2(vsByCurrency?.get(currency) ?? 0)
      const diff = round2(period - vs)
      const diffPct = vs === 0 ? null : round1((diff / vs) * 100)
      rows.push({ key, currency, period, vs, diff, diffPct })
    }
  }

  return rows.sort((a, b) => a.key.localeCompare(b.key, 'ru') || (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))
}
