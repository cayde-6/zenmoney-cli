import type { Dataset, Tx } from '../query/model.js'
import { isSpendTx, spendSign } from '../query/model.js'
import { resolveCategory } from '../query/filters.js'
import { spendBy, type Group } from '../analytics/spend.js'
import { round1, round2, daysInMonth, localMonth } from '../util.js'
import { ZmError } from '../errors.js'
import type { LimitSpec } from './files.js'

export interface StatusRow {
  category: string; categoryId: string; currency: string
  planned: number; spent: number; spentOtherCurrencies: Array<{ currency: string; amount: number }>
  remaining: number; usedPct: number | null; monthElapsedPct: number; pace: number | null
}
export interface BudgetStatus { month: string; monthElapsedPct: number; rows: StatusRow[]; unplanned: Group[] }

export function monthElapsedPct(month: string, now: Date): number {
  const current = localMonth(now)
  if (month < current) return 100
  if (month > current) return 0
  return round1((now.getDate() / daysInMonth(month)) * 100)
}

interface RowAccum { category: string; categoryId: string; planned: LimitSpec; totals: Map<string, number> }

export function budgetStatus(ds: Dataset, limits: Map<string, LimitSpec>, monthTxs: Tx[], month: string, now: Date): BudgetStatus {
  const elapsed = monthElapsedPct(month, now)

  const rowById = new Map<string, RowAccum>()
  const keyById = new Map<string, string>() // categoryId -> the limit key that first resolved to it, for the collision message
  for (const [key, limit] of limits) {
    const resolved = resolveCategory(ds, key)
    const existingKey = keyById.get(resolved.id)
    if (existingKey !== undefined) {
      throw new ZmError(
        'INVALID_ARGS',
        `limits "${existingKey}" and "${key}" refer to the same category ${resolved.path}`,
        'write the key the same way in default.yaml and the month file',
      )
    }
    keyById.set(resolved.id, key)
    rowById.set(resolved.id, { category: resolved.path, categoryId: resolved.id, planned: limit, totals: new Map() })
  }

  const unplannedTxs: Tx[] = []
  for (const t of monthTxs) {
    if (!isSpendTx(t)) continue
    const row = (t.categoryId !== null ? rowById.get(t.categoryId) : undefined)
      ?? (t.topCategoryId !== null ? rowById.get(t.topCategoryId) : undefined)
    if (!row) {
      unplannedTxs.push(t)
      continue
    }
    row.totals.set(t.currency, (row.totals.get(t.currency) ?? 0) + spendSign(t))
  }

  const rows: StatusRow[] = [...rowById.values()]
    .map(acc => {
      const spent = round2(acc.totals.get(acc.planned.currency) ?? 0)
      const spentOtherCurrencies = [...acc.totals.entries()]
        .filter(([currency]) => currency !== acc.planned.currency)
        .map(([currency, amount]) => ({ currency, amount: round2(amount) }))
        .filter(a => a.amount !== 0)
        .sort((a, b) => a.currency.localeCompare(b.currency))
      const remaining = round2(acc.planned.amount - spent)
      const usedPct = acc.planned.amount > 0 ? round1((spent / acc.planned.amount) * 100) : null
      const pace = usedPct === null ? null : round1(usedPct - elapsed)
      return {
        category: acc.category, categoryId: acc.categoryId, currency: acc.planned.currency,
        planned: acc.planned.amount, spent, spentOtherCurrencies,
        remaining, usedPct, monthElapsedPct: elapsed, pace,
      }
    })
    .sort((a, b) => a.category.localeCompare(b.category, 'ru'))

  const unplanned = spendBy(unplannedTxs, 'category')

  return { month, monthElapsedPct: elapsed, rows, unplanned }
}
