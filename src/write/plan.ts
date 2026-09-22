// Pure planning for `zm edit`/`add`/`delete`: turns already-resolved targets
// and field input into PlannedChange rows plus a deterministic plan token,
// with no I/O, no network, and no store writes (see docs/architecture.md and
// docs/superpowers/specs/2026-09-22-tx-write-mode-design.md). Callers (the
// CLI commands) do target lookup, formatting, and the apply flow; this
// module only decides what a change's raw diff looks like and whether one
// has already landed.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ZmTransaction } from '../api/types.js'
import { classify, type Dataset } from '../query/model.js'
import { ZmError } from '../errors.js'

export type WriteOp = 'create' | 'update' | 'delete'

export interface PlannedChange {
  op: WriteOp
  id: string
  base: ZmTransaction | null // cached raw before; null for create
  next: ZmTransaction // raw to send (changed/created fixed later by apply); for delete: base with deleted: true
  set: Record<string, unknown> // raw field -> new value; create: whole object minus changed/created; delete: {}
}

export interface EditFields {
  comment?: string; payee?: string; categoryId?: string; date?: string; amount?: number; accountId?: string
}

export interface AddInput {
  id: string; kind: 'expense' | 'income'; amount: number; accountId: string
  categoryId?: string; date: string; comment?: string; payee?: string
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/

export function parseAmount(raw: string, flag: string): number {
  const n = Number(raw)
  if (!AMOUNT_RE.test(raw) || !(n > 0)) {
    throw new ZmError('INVALID_ARGS', `invalid ${flag}: ${raw}`, 'a positive number with at most 2 decimals, e.g. 33.88')
  }
  return n
}

// A "single-currency simple transaction" (design spec's Terms) is the only
// kind `--amount`/`--account` may touch. When both income and outcome are 0,
// `classify` assumes a money-carrying row (loadDataset never calls it
// otherwise) and would misreport such a row as income/refund — so the
// classify-based transfer/debt check is skipped for those, and only the
// instrument/op-field checks below apply.
export function isRestricted(t: ZmTransaction, ds: Dataset): boolean {
  if (t.income === 0 && t.outcome === 0) {
    // A zero-money row still moving between two different accounts is a
    // zero-money transfer, restricted the same as a money-carrying one --
    // classify() itself can't be used to tell (see the comment above).
    if (t.incomeAccount !== t.outcomeAccount) return true
  } else {
    const type = classify(t, ds.accounts, ds.tags)
    if (type === 'transfer' || type === 'debt') return true
  }
  if (t.incomeInstrument !== t.outcomeInstrument) return true
  if (typeof t.opIncome === 'number' && t.opIncome !== 0) return true
  if (typeof t.opOutcome === 'number' && t.opOutcome !== 0) return true
  if (t.opIncomeInstrument != null) return true
  if (t.opOutcomeInstrument != null) return true
  return false
}

export function planEdit(ds: Dataset, targets: ZmTransaction[], f: EditFields): PlannedChange[] {
  const touchesRestrictedFields = f.amount !== undefined || f.accountId !== undefined
  if (touchesRestrictedFields) {
    const restrictedIds = targets.filter(t => isRestricted(t, ds)).map(t => t.id)
    if (restrictedIds.length > 0) {
      throw new ZmError(
        'INVALID_ARGS',
        '--amount/--account cannot change a transfer, debt, or foreign-currency transaction',
        restrictedIds.join(', '),
      )
    }
  }

  if (f.amount !== undefined) {
    const noAmountIds = targets.filter(t => t.income === 0 && t.outcome === 0).map(t => t.id)
    if (noAmountIds.length > 0) {
      throw new ZmError('INVALID_ARGS', '--amount cannot change a transaction with no amount', noAmountIds.join(', '))
    }
  }

  return targets.map(base => {
    const set: Record<string, unknown> = {}

    if (f.comment !== undefined) set.comment = f.comment === '' ? null : f.comment

    if (f.payee !== undefined) {
      if (f.payee === '') {
        set.payee = null
      } else {
        set.payee = f.payee
        set.merchant = null
      }
    }

    if (f.categoryId !== undefined) set.tag = [f.categoryId]

    if (f.date !== undefined) set.date = f.date

    if (f.amount !== undefined) {
      if (base.outcome > 0) set.outcome = f.amount
      else set.income = f.amount
    }

    if (f.accountId !== undefined) {
      const account = ds.accounts.get(f.accountId)
      if (!account) throw new ZmError('INVALID_ARGS', `unknown account: ${f.accountId}`, 'pass an existing account id')
      if (account.type === 'debt') {
        throw new ZmError('INVALID_ARGS', 'cannot move a transaction to a debt account', 'edit debt-account moves in the ZenMoney app instead')
      }
      if (account.instrument !== base.outcomeInstrument) {
        throw new ZmError('INVALID_ARGS', 'target account has a different currency', 'edit currency-changing moves in the ZenMoney app instead')
      }
      set.incomeAccount = f.accountId
      set.outcomeAccount = f.accountId
    }

    const next: ZmTransaction = { ...base, ...set }
    return { op: 'update', id: base.id, base, next, set }
  })
}

export function planAdd(ds: Dataset, input: AddInput): PlannedChange[] {
  const account = ds.accounts.get(input.accountId)
  if (!account) throw new ZmError('INVALID_ARGS', `unknown account: ${input.accountId}`, 'pass an existing account id')
  if (account.type === 'debt') {
    throw new ZmError('INVALID_ARGS', 'cannot add a transaction on a debt account', 'add debt-account transactions in the ZenMoney app instead')
  }
  if (account.instrument === null) {
    throw new ZmError('INVALID_ARGS', `account has no currency: ${input.accountId}`, 'pick a different account')
  }
  const instrument = account.instrument

  const fields = {
    date: input.date,
    income: input.kind === 'income' ? input.amount : 0,
    outcome: input.kind === 'expense' ? input.amount : 0,
    incomeAccount: input.accountId,
    outcomeAccount: input.accountId,
    incomeInstrument: instrument,
    outcomeInstrument: instrument,
    tag: input.categoryId ? [input.categoryId] : null,
    merchant: null,
    payee: input.payee ? input.payee : null,
    comment: input.comment ? input.comment : null,
    hold: false,
    deleted: false,
  }
  const next: ZmTransaction = { id: input.id, user: account.user, ...fields, created: 0, changed: 0 }
  const set: Record<string, unknown> = { id: input.id, user: account.user, ...fields }

  return [{ op: 'create', id: input.id, base: null, next, set }]
}

export function planDelete(targets: ZmTransaction[]): PlannedChange[] {
  return targets.map(base => ({ op: 'delete' as const, id: base.id, base, next: { ...base, deleted: true }, set: {} }))
}

// JSON with object keys sorted recursively (arrays keep their order,
// `undefined` object values are omitted, exactly like JSON.stringify) — so
// planToken's hash never depends on the insertion order of a `set` object.
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(v => canonical(v === undefined ? null : v)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function planToken(changes: PlannedChange[]): string {
  const rows = changes
    .map(c => ({ op: c.op, id: c.id, baseChanged: c.base?.changed ?? null, set: c.set }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return createHash('sha256').update(canonical(rows)).digest('hex').slice(0, 16)
}

// `create`'s retry check only compares the fields that actually describe the
// transaction's money/where/what — never `hold`/`merchant`/`user`/`created`/
// `changed` (some of `set`'s other keys) — because the server is free to
// normalise those, or an empty string, when it echoes a write back in the
// response diff or a later sync. Comparing the full `set` there would make a
// write that landed exactly as planned look like a conflict just because
// ZenMoney's own echo differs from our request in an insignificant way.
const CREATE_COMPARE_FIELDS = [
  'date', 'income', 'outcome', 'incomeAccount', 'outcomeAccount',
  'incomeInstrument', 'outcomeInstrument', 'tag', 'payee', 'comment',
]

// null, undefined, and '' are the same "nothing here" for retry-detection
// purposes, for the same reason as CREATE_COMPARE_FIELDS above: the server's
// echo of an unset field isn't guaranteed to use the same one of the three
// we sent.
function normalizeForCompare(v: unknown): unknown {
  return v === undefined || v === null || v === '' ? null : v
}

export function isApplied(c: PlannedChange, current: ZmTransaction | null): boolean {
  if (c.op === 'delete') return current === null || current.deleted === true
  if (current === null || current.deleted) return false
  const row = current as unknown as Record<string, unknown>
  // `merchant` is dropped from an 'update' comparison even when it's one of
  // `set`'s keys: planEdit only ever sets it (to null) as a side effect of
  // --payee, and the server is free to re-link a merchant from the new
  // payee text on its own. Comparing it here would make a write that landed
  // exactly as planned look permanently unapplied over a field the caller
  // never actually asked to control.
  const keys = c.op === 'create' ? CREATE_COMPARE_FIELDS : Object.keys(c.set).filter(k => k !== 'merchant')
  return keys.every(k => isDeepStrictEqual(normalizeForCompare(row[k]), normalizeForCompare(c.set[k])))
}
