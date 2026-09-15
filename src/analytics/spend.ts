import type { Tx } from '../query/model.js'
import { NO_CATEGORY, isSpendTx, spendSign } from '../query/model.js'
import type { ZmTag } from '../api/types.js'
import { compareNames, monthOf, round2 } from '../util.js'
import { ZmError } from '../errors.js'

export interface Amount { currency: string; amount: number; count: number }
export interface Group { key: string; amounts: Amount[]; children?: Group[] }
export type SpendBy = 'category' | 'month' | 'merchant'

// Sums an already-selected list of txs per currency using `sign` (e.g. +amount
// for expense, -amount for refund). Every tx in `txs` counts — no further
// filtering happens here, that's the caller's job.
export function sumByCurrency(txs: Tx[], sign: (t: Tx) => number): Amount[] {
  const totals = new Map<string, { amount: number; count: number }>()
  for (const t of txs) {
    const entry = totals.get(t.currency) ?? { amount: 0, count: 0 }
    entry.amount += sign(t)
    entry.count += 1
    totals.set(t.currency, entry)
  }
  return [...totals.entries()]
    .map(([currency, v]) => ({ currency, amount: round2(v.amount), count: v.count }))
    .sort((a, b) => compareNames(a.currency, b.currency))
}

function keyOf(t: Tx, by: 'category' | 'month' | 'merchant'): string {
  if (by === 'category') return t.categoryPath
  if (by === 'month') return monthOf(t.date)
  return t.merchant ?? '(no merchant)'
}

function compareKeys(by: 'category' | 'month' | 'merchant', a: string, b: string): number {
  return by === 'month' ? (a < b ? -1 : a > b ? 1 : 0) : compareNames(a, b)
}

function groupTxs(txs: Tx[], by: 'category' | 'month' | 'merchant', sign: (t: Tx) => number): Group[] {
  const buckets = new Map<string, Tx[]>()
  for (const t of txs) {
    const key = keyOf(t, by)
    const bucket = buckets.get(key) ?? []
    bucket.push(t)
    buckets.set(key, bucket)
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => ({ key, amounts: sumByCurrency(bucket, sign) }))
    .sort((a, b) => compareKeys(by, a.key, b.key))
}

function treeByCategory(spendTxs: Tx[], tags: Map<string, ZmTag>): Group[] {
  // Bucket by the top category's id, not its title: two distinct top
  // categories can share the same title, and bucketing by title text alone
  // would silently merge their transactions into one group.
  const topBuckets = new Map<string | null, Tx[]>()
  for (const t of spendTxs) {
    const bucket = topBuckets.get(t.topCategoryId) ?? []
    bucket.push(t)
    topBuckets.set(t.topCategoryId, bucket)
  }

  const titleOf = (id: string | null) => id === null ? NO_CATEGORY : (tags.get(id)?.title.trim() ?? NO_CATEGORY)
  const titleCounts = new Map<string, number>()
  for (const id of topBuckets.keys()) {
    const title = titleOf(id)
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
  }

  return [...topBuckets.entries()]
    .map(([id, bucket]) => {
      const title = titleOf(id)
      // The display key stays the plain title, except when two different top
      // categories share it — then disambiguate as "Title (id)".
      const key = id !== null && (titleCounts.get(title) ?? 0) > 1 ? `${title} (${id})` : title
      const group: Group = { key, amounts: sumByCurrency(bucket, spendSign) }
      const childTxs = bucket.filter(t => t.categoryId !== t.topCategoryId)
      if (childTxs.length > 0) group.children = groupTxs(childTxs, 'category', spendSign)
      return group
    })
    .sort((a, b) => compareKeys('category', a.key, b.key))
}

// Spend = expense (+amount) and refund (-amount) txs only; income/transfer/debt
// are ignored entirely (not counted, not summed).
export function spendBy(txs: Tx[], by: SpendBy, opts?: { tree?: boolean; tags?: Map<string, ZmTag> }): Group[] {
  const spendTxs = txs.filter(isSpendTx)
  if (opts?.tree && by === 'category') {
    if (!opts.tags) throw new ZmError('UNEXPECTED', 'spendBy: tree requires tags to resolve category titles')
    return treeByCategory(spendTxs, opts.tags)
  }
  return groupTxs(spendTxs, by, spendSign)
}

export function incomeBy(txs: Tx[], by: 'category' | 'month'): Group[] {
  const incomeTxs = txs.filter(t => t.type === 'income')
  return groupTxs(incomeTxs, by, t => t.amount)
}
