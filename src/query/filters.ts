import { ZmError } from '../errors.js'
import { suggest, monthRange } from '../util.js'
import type { ZmAccount } from '../api/types.js'
import { categoryPath, meUser, type Dataset, type Tx, type TxType } from './model.js'

export interface Filters {
  from?: string; to?: string; month?: string; category?: string; account?: string
  currency?: string; owner?: string; type?: TxType[]; search?: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

// Regex only checks shape; a calendar-invalid value like 2026-02-30 or a month
// like 2026-13 must still round-trip through Date to be accepted.
function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

export function isValidMonth(s: string): boolean {
  if (!MONTH_RE.test(s)) return false
  const m = Number(s.slice(5, 7))
  return m >= 1 && m <= 12
}

export function resolvePeriod(f: Pick<Filters, 'from' | 'to' | 'month'>): { from: string | null; to: string | null } {
  if (f.month && (f.from || f.to)) throw new ZmError('INVALID_ARGS', 'cannot combine --month with --from/--to')
  if (f.month) {
    if (!isValidMonth(f.month)) throw new ZmError('INVALID_ARGS', `invalid month: ${f.month}`, 'use YYYY-MM')
    return monthRange(f.month)
  }
  if (f.from !== undefined && !isValidDate(f.from)) throw new ZmError('INVALID_ARGS', `invalid date: ${f.from}`, 'use YYYY-MM-DD')
  if (f.to !== undefined && !isValidDate(f.to)) throw new ZmError('INVALID_ARGS', `invalid date: ${f.to}`, 'use YYYY-MM-DD')
  if (f.from !== undefined && f.to !== undefined && f.from > f.to) {
    throw new ZmError('INVALID_ARGS', `--from (${f.from}) is after --to (${f.to})`)
  }
  return { from: f.from ?? null, to: f.to ?? null }
}

function collectDescendants(id: string, tags: Dataset['tags']): Set<string> {
  const ids = new Set<string>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const tag of tags.values()) {
      if (tag.parent && ids.has(tag.parent) && !ids.has(tag.id)) {
        ids.add(tag.id)
        changed = true
      }
    }
  }
  return ids
}

function allCategoryPaths(ds: Dataset): { id: string; path: string }[] {
  return [...ds.tags.values()].map(tag => ({ id: tag.id, path: categoryPath(tag.id, ds.tags) }))
}

export function resolveCategory(ds: Dataset, query: string): { id: string; path: string; ids: Set<string> } {
  const q = query.trim().toLowerCase()
  const all = allCategoryPaths(ds)

  const byPath = all.filter(c => c.path.toLowerCase() === q)
  if (byPath.length === 1) {
    const match = byPath[0]!
    return { id: match.id, path: match.path, ids: collectDescendants(match.id, ds.tags) }
  }
  if (byPath.length > 1) {
    throw new ZmError('INVALID_ARGS', `ambiguous category: ${query}`, byPath.map(c => `${c.path} (${c.id})`).join(', '))
  }

  const byId = all.find(c => c.id.toLowerCase() === q)
  if (byId) return { id: byId.id, path: byId.path, ids: collectDescendants(byId.id, ds.tags) }

  const byLeaf = all.filter(c => {
    const leaf = c.path.split('/').pop() ?? ''
    return leaf.toLowerCase() === q
  })
  if (byLeaf.length === 1) {
    const match = byLeaf[0]!
    return { id: match.id, path: match.path, ids: collectDescendants(match.id, ds.tags) }
  }
  if (byLeaf.length > 1) {
    throw new ZmError('INVALID_ARGS', `ambiguous category: ${query}`, byLeaf.map(c => c.path).join(', '))
  }

  const hint = `did you mean: ${suggest(all.map(c => c.path), query).join(', ')}`
  throw new ZmError('INVALID_ARGS', `unknown category: ${query}`, hint)
}

export function resolveOwner(ds: Dataset, owner: string | undefined): Set<number> | null {
  if (owner === undefined || owner === 'all') return null
  if (owner === 'me') return new Set([meUser(ds).id])
  if (/^\d+$/.test(owner)) {
    const id = Number(owner)
    if (ds.users.some(u => u.id === id)) return new Set([id])
  }
  const byLogin = ds.users.find(u => u.login?.toLowerCase() === owner.toLowerCase())
  if (byLogin) return new Set([byLogin.id])
  const hint = `did you mean: ${suggest(ds.users.map(u => u.login ?? String(u.id)), owner).join(', ')}`
  throw new ZmError('INVALID_ARGS', `unknown owner: ${owner}`, hint)
}

function titleWithId(a: ZmAccount): string {
  return `${a.title} (${a.id})`
}

export function resolveAccount(ds: Dataset, query: string): ZmAccount {
  const accounts = [...ds.accounts.values()]
  const byId = ds.accounts.get(query)
  if (byId) return byId

  const q = query.trim().toLowerCase()

  // An exact (case-insensitive, trimmed) title match wins even when the query
  // is also a substring of other titles (e.g. "Cash" vs "Old Cash").
  const exact = accounts.filter(a => a.title.trim().toLowerCase() === q)
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1) {
    throw new ZmError('INVALID_ARGS', `ambiguous account: ${query}`, exact.map(titleWithId).join(', '))
  }

  const matches = accounts.filter(a => a.title.toLowerCase().includes(q))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new ZmError('INVALID_ARGS', `ambiguous account: ${query}`, matches.map(titleWithId).join(', '))
  }
  const hint = `did you mean: ${suggest(accounts.map(titleWithId), query).join(', ')}`
  throw new ZmError('INVALID_ARGS', `unknown account: ${query}`, hint)
}

// A `--currency` that matches no instrument actually used by any account or
// transaction is almost always a typo (e.g. wrong case, or a currency this
// ZenMoney account never touched) — the filter itself still runs (and quietly
// returns nothing), but this surfaces a warning instead of a silent empty result.
export function currencyWarnings(ds: Dataset, currency: string | undefined): string[] {
  if (currency === undefined) return []
  const known = new Set<string>()
  for (const a of ds.accounts.values()) {
    const title = a.instrument !== null ? ds.instruments.get(a.instrument)?.shortTitle : undefined
    if (title) known.add(title.toLowerCase())
  }
  for (const t of ds.txs) known.add(t.currency.toLowerCase())
  if (known.has(currency.trim().toLowerCase())) return []
  return [`unknown currency: ${currency}`]
}

export function applyFilters(ds: Dataset, f: Filters): Tx[] {
  const { from, to } = resolvePeriod(f)
  const categoryIds = f.category ? resolveCategory(ds, f.category).ids : null
  const accountId = f.account ? resolveAccount(ds, f.account).id : null
  const ownerIds = resolveOwner(ds, f.owner)
  const currency = f.currency?.trim().toLowerCase()
  const search = f.search?.trim().toLowerCase()

  return ds.txs.filter(t => {
    if (from !== null && t.date < from) return false
    if (to !== null && t.date > to) return false
    if (categoryIds !== null && (t.categoryId === null || !categoryIds.has(t.categoryId))) return false
    if (accountId !== null && t.accountId !== accountId && t.counterpart?.accountId !== accountId) return false
    if (currency !== undefined && t.currency.toLowerCase() !== currency) return false
    if (ownerIds !== null && !ownerIds.has(t.ownerId)) return false
    if (f.type && f.type.length > 0 && !f.type.includes(t.type)) return false
    if (search !== undefined) {
      const haystack = [t.merchant, t.payee, t.comment, t.categoryPath].filter((v): v is string => v !== null).join(' ').toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}
