import { ZmError } from '../errors.js'
import { suggest, monthRange } from '../util.js'
import type { ZmAccount } from '../api/types.js'
import { categoryPath, meUser, type Dataset, type Tx, type TxType } from './model.js'

export interface Filters {
  from?: string; to?: string; month?: string; category?: string; account?: string
  currency?: string; owner?: string; type?: TxType[]; search?: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// Shared with analytics/compare.ts's parsePeriod, which also needs to tell a
// bare YYYY-MM apart from a YYYY-MM-DD..YYYY-MM-DD range before validating it.
export const MONTH_RE = /^\d{4}-\d{2}$/

// Regex only checks shape; a calendar-invalid value like 2026-02-30 or a month
// like 2026-13 must still round-trip through Date to be accepted.
export function isValidDate(s: string): boolean {
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

// `leaf` is the tag's own (trimmed) title, not a segment split out of `path` —
// a title can itself contain "/" (e.g. "Phone/Internet"), and splitting the
// joined path on "/" would then extract the wrong, partial "leaf" text.
function allCategoryPaths(ds: Dataset): { id: string; path: string; leaf: string }[] {
  return [...ds.tags.values()].map(tag => ({ id: tag.id, path: categoryPath(tag.id, ds.tags), leaf: tag.title.trim() }))
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

  const byLeaf = all.filter(c => c.leaf.toLowerCase() === q)
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

// Today's ZenMoney-user owner semantics (me/login/id), used only when the
// family has no owners.yaml at all (ds.ownerNames === null) — see
// resolveOwnerName below for the owners.yaml-backed replacement.
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

// `--owner` semantics once owners.yaml exists: 'all' (default), 'unassigned',
// or one of the file's own owner names — the old me/login/id semantics
// (resolveOwner above) no longer apply. `ownerNames` is `Dataset.ownerNames`
// and `filePath` is `Dataset.ownersPath`, both already known non-null by
// every caller. Matching is case-insensitive (so `--owner ALEX` finds an
// owner spelled "alex"), but the returned value is always the file's own
// spelling, never the caller's casing — so anything built from it (e.g. a
// `meta.owner` echo) shows what's actually in the file.
//
// Unlike category/account's did-you-mean (top-3 closest by edit distance),
// the hint here lists every defined owner name outright: with typically
// only a handful of family members, the whole list is more useful than a
// fuzzy guess, and it doubles as a quick reminder of what's in the file
// without having to run `zm owners` first.
export function resolveOwnerName(ownerNames: string[], filePath: string, owner: string | undefined): string {
  const value = owner ?? 'all'
  if (value === 'all' || value === 'unassigned') return value
  const match = ownerNames.find(n => n.toLowerCase() === value.toLowerCase())
  if (match !== undefined) return match
  const defines = ownerNames.length > 0 ? `defines: ${ownerNames.join(', ')}` : 'defines no owners'
  const hint = `owners.yaml (${filePath}) ${defines}; also accepted: all, unassigned`
  throw new ZmError('INVALID_ARGS', `unknown owner: ${value}`, hint)
}

// The value every command's `meta.owner` should echo: once owners.yaml
// exists, the file's own spelling (e.g. `--owner ALEX` echoes "alex"), same
// as what applyFilters actually filtered on — not the caller's raw casing.
// With no owners.yaml, unchanged: the raw option value (today's
// me/login/id semantics don't have a single "canonical spelling" to
// resolve to). Re-resolves via resolveOwnerName rather than caching the
// result from applyFilters — cheap and pure, and by the time a command
// builds its `meta`, resolution has already succeeded once, so this can't
// newly throw.
export function ownerMetaValue(ds: Dataset, owner: string | undefined): string {
  if (ds.ownerNames === null) return owner ?? 'all'
  return resolveOwnerName(ds.ownerNames, ds.ownersPath ?? 'owners.yaml', owner)
}

// Shared by applyFilters and by any command (e.g. `accounts`) that needs to
// test a single Tx/account owner name against an already-resolved `--owner`
// value, without repeating the 'all'/'unassigned' special-casing.
export function ownerNameMatches(resolved: string, ownerName: string | null): boolean {
  if (resolved === 'all') return true
  if (resolved === 'unassigned') return ownerName === null
  return ownerName === resolved
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

// Every currency (instrument shortTitle) actually in use in the dataset: any
// account's own currency, plus both sides of every non-deleted transaction
// (ds.txs already excludes deleted ones) — a transfer/debt's counterpart
// currency is only visible via Tx.counterpart, not instrument ids, since
// loadDataset already resolved those to shortTitles. Shared by
// currencyWarnings below and by `zm rates`.
export function usedCurrencies(ds: Dataset): Set<string> {
  const used = new Set<string>()
  for (const a of ds.accounts.values()) {
    const title = a.instrument !== null ? ds.instruments.get(a.instrument)?.shortTitle : undefined
    if (title) used.add(title)
  }
  for (const t of ds.txs) {
    used.add(t.currency)
    if (t.counterpart) used.add(t.counterpart.currency)
  }
  return used
}

// A `--currency` that matches no instrument actually used by any account or
// transaction is almost always a typo (e.g. wrong case, or a currency this
// ZenMoney account never touched) — the filter itself still runs (and quietly
// returns nothing), but this surfaces a warning instead of a silent empty result.
export function currencyWarnings(ds: Dataset, currency: string | undefined): string[] {
  if (currency === undefined) return []
  const known = new Set([...usedCurrencies(ds)].map(c => c.toLowerCase()))
  if (known.has(currency.trim().toLowerCase())) return []
  return [`unknown currency: ${currency}`]
}

// `--category`/`--account` resolution (and the ZmError it can throw for an
// unknown/ambiguous query) as a single step, shared by applyFilters and by
// the command's own `meta.category`/`meta.account` — resolving twice per
// command (once here, once again inside applyFilters) would do the same
// tag/account lookup work twice for every invocation.
export interface ResolvedRefs { categoryPath: string | null; categoryIds: Set<string> | null; accountId: string | null }

export function resolveFilterRefs(ds: Dataset, f: Pick<Filters, 'category' | 'account'>): ResolvedRefs {
  const category = f.category ? resolveCategory(ds, f.category) : null
  const account = f.account ? resolveAccount(ds, f.account) : null
  return {
    categoryPath: category?.path ?? null,
    categoryIds: category?.ids ?? null,
    accountId: account?.id ?? null,
  }
}

export function applyFilters(ds: Dataset, f: Filters, resolved?: ResolvedRefs): Tx[] {
  const { from, to } = resolvePeriod(f)
  const refs = resolved ?? resolveFilterRefs(ds, f)
  const categoryIds = refs.categoryIds
  const accountId = refs.accountId
  // owners.yaml present -> name/unassigned/all semantics on Tx.owner;
  // absent -> today's ZenMoney-user (me/login/id) semantics on Tx.ownerId.
  const ownerIds = ds.ownerNames === null ? resolveOwner(ds, f.owner) : null
  const ownerName = ds.ownerNames !== null ? resolveOwnerName(ds.ownerNames, ds.ownersPath ?? 'owners.yaml', f.owner) : null
  const currency = f.currency?.trim().toLowerCase()
  const search = f.search?.trim().toLowerCase()

  return ds.txs.filter(t => {
    if (from !== null && t.date < from) return false
    if (to !== null && t.date > to) return false
    if (categoryIds !== null && (t.categoryId === null || !categoryIds.has(t.categoryId))) return false
    if (accountId !== null && t.accountId !== accountId && t.counterpart?.accountId !== accountId) return false
    if (currency !== undefined && t.currency.toLowerCase() !== currency) return false
    if (ownerIds !== null && !ownerIds.has(t.ownerId)) return false
    if (ownerName !== null && !ownerNameMatches(ownerName, t.owner)) return false
    if (f.type && f.type.length > 0 && !f.type.includes(t.type)) return false
    if (search !== undefined) {
      const haystack = [t.merchant, t.payee, t.comment, t.categoryPath].filter((v): v is string => v !== null).join(' ').toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}
