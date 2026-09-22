// Turns a PlannedChange list (src/write/plan.ts) into what a dry run or an
// apply result shows: per-change before/after views, per-account balance
// impact, `--format table` rows, and the ready-to-paste apply command. Pure,
// no I/O.
import type { ZmTransaction } from '../api/types.js'
import { toTx, type Dataset, type Tx } from '../query/model.js'
import type { TableRow } from '../cli/output.js'
import type { PlannedChange, WriteOp } from './plan.js'

export interface BalanceImpact { accountId: string; accountTitle: string; currency: string; delta: number }
export interface ChangeView { op: WriteOp; id: string; before: Tx | null; after: Tx | null; fields: string[]; raw?: ZmTransaction }
export interface WriteData {
  applied: boolean
  token: string
  applyCommand: string | null
  changes: ChangeView[]
  balanceImpact: BalanceImpact[]
}

// A raw tx's money contribution to each account it touches: +income on
// incomeAccount, -outcome on outcomeAccount (the same account for a
// single-currency simple transaction, two different ones for a
// transfer/debt row). null/deleted contributes nothing.
function contribution(t: ZmTransaction | null): Map<string, number> {
  const m = new Map<string, number>()
  if (!t || t.deleted) return m
  m.set(t.incomeAccount, (m.get(t.incomeAccount) ?? 0) + t.income)
  m.set(t.outcomeAccount, (m.get(t.outcomeAccount) ?? 0) - t.outcome)
  return m
}

export function balanceImpact(ds: Dataset, changes: PlannedChange[]): BalanceImpact[] {
  const totals = new Map<string, number>()
  for (const c of changes) {
    const before = contribution(c.base)
    const after = contribution(c.next)
    const accountIds = new Set([...before.keys(), ...after.keys()])
    for (const accountId of accountIds) {
      const delta = (after.get(accountId) ?? 0) - (before.get(accountId) ?? 0)
      totals.set(accountId, (totals.get(accountId) ?? 0) + delta)
    }
  }

  const result: BalanceImpact[] = []
  for (const [accountId, rawDelta] of totals) {
    const delta = Math.round(rawDelta * 100) / 100
    if (delta === 0) continue
    const account = ds.accounts.get(accountId)
    const currency = account?.instrument != null ? (ds.instruments.get(account.instrument)?.shortTitle ?? '') : ''
    result.push({ accountId, accountTitle: account?.title ?? accountId, currency, delta })
  }
  result.sort((a, b) => (a.accountTitle < b.accountTitle ? -1 : a.accountTitle > b.accountTitle ? 1 : 0))
  return result
}

export function changeViews(ds: Dataset, changes: PlannedChange[]): ChangeView[] {
  return changes.map(c => ({
    op: c.op,
    id: c.id,
    before: c.base ? toTx(c.base, ds) : null,
    after: c.op === 'delete' ? null : toTx(c.next, ds),
    fields: Object.keys(c.set).sort(),
    ...(c.op === 'delete' ? { raw: c.base as ZmTransaction } : {}),
  }))
}

function fmt(v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'object') return JSON.stringify(v)
  return v as string | number | boolean
}

export function tableRows(changes: PlannedChange[]): TableRow[] {
  const rows: TableRow[] = []
  for (const c of changes) {
    if (c.op === 'delete') {
      rows.push({ id: c.id, op: c.op, field: '*', before: null, after: null })
      continue
    }
    const base = c.base as unknown as Record<string, unknown> | null
    const next = c.next as unknown as Record<string, unknown>
    for (const field of Object.keys(c.set).sort()) {
      rows.push({ id: c.id, op: c.op, field, before: fmt(base?.[field]), after: fmt(next[field]) })
    }
  }
  return rows
}

const SHELL_SAFE_RE = /^[A-Za-z0-9_\-.,:/@=+]+$/

export function shellQuote(s: string): string {
  if (SHELL_SAFE_RE.test(s)) return s
  return `'${s.replaceAll("'", "'\\''")}'`
}

export function applyCommand(argv: string[], token: string): string {
  const filtered: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--apply') continue
    if (a === '--expect') {
      i++ // also drop its value
      continue
    }
    if (a.startsWith('--expect=')) continue
    filtered.push(a)
  }
  return ['zm', ...filtered, '--apply', '--expect', token].map(shellQuote).join(' ')
}
