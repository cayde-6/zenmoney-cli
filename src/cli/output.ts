import { ZmError, EXIT, type ErrorCode } from '../errors.js'
import type { Group } from '../analytics/spend.js'
import type { Tx } from '../query/model.js'

export type Format = 'json' | 'table'

export interface Envelope<T> {
  data: T
  meta: Record<string, unknown>
  warnings?: string[]
  table?: Array<Record<string, string | number | null>>
}

function isFlatObjectArray(data: unknown): data is Record<string, unknown>[] {
  if (!Array.isArray(data)) return false
  return data.every(
    item =>
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      Object.values(item as object).every(v => v === null || typeof v !== 'object'),
  )
}

function writeTable(rows: Record<string, unknown>[], write: (s: string) => void): void {
  const keys: string[] = []
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!keys.includes(k)) keys.push(k)
    }
  }
  const widths = keys.map(k => Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length)))
  write(keys.map((k, i) => k.padEnd(widths[i]!)).join('  ') + '\n')
  for (const row of rows) {
    write(keys.map((k, i) => String(row[k] ?? '').padEnd(widths[i]!)).join('  ') + '\n')
  }
}

export function printResult<T>(env: Envelope<T>, format: Format, write: (s: string) => void): void {
  if (format === 'json') {
    const { data, meta, warnings } = env
    write(JSON.stringify({ data, meta, ...(warnings !== undefined ? { warnings } : {}) }, null, 2) + '\n')
    return
  }

  const rows = env.table ?? (isFlatObjectArray(env.data) ? env.data : null)
  if (rows && rows.length > 0) {
    writeTable(rows, write)
  } else {
    write(JSON.stringify(env.data, null, 2) + '\n')
  }

  for (const w of env.warnings ?? []) {
    write(`warning: ${w}\n`)
  }
}

// Flattens spend/income groups into rows for `--format table`: one row per
// (group, currency), plus one indented row per child group's amounts.
export function flattenGroups(groups: Group[]): Array<Record<string, string | number>> {
  const rows: Array<Record<string, string | number>> = []
  for (const group of groups) {
    for (const a of group.amounts) {
      rows.push({ key: group.key, currency: a.currency, amount: a.amount, count: a.count })
    }
    for (const child of group.children ?? []) {
      for (const a of child.amounts) {
        rows.push({ key: '  ' + child.key, currency: a.currency, amount: a.amount, count: a.count })
      }
    }
  }
  return rows
}

// Flattens `tx` rows for `--format table`: a transfer/debt's nested `counterpart`
// object would otherwise make the whole result fail the "flat object array"
// check and fall back to a raw JSON dump, so it's spread into three columns.
export function flattenTxTable(txs: Tx[]): Array<Record<string, string | number | null>> {
  return txs.map(t => {
    const { counterpart, ...rest } = t
    return {
      ...rest,
      counterpartAccount: counterpart?.accountTitle ?? null,
      counterpartAmount: counterpart?.amount ?? null,
      counterpartCurrency: counterpart?.currency ?? null,
    }
  })
}

function stripErrorPrefix(message: string): string {
  return message.startsWith('error: ') ? message.slice('error: '.length) : message
}

export function printError(err: unknown, format: Format, write: (s: string) => void): number {
  let code: ErrorCode
  let message: string
  let hint: string | undefined

  if (err instanceof ZmError) {
    code = err.code
    message = err.message
    hint = err.hint
  } else if (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('commander.')
  ) {
    code = 'INVALID_ARGS'
    message = stripErrorPrefix(err instanceof Error ? err.message : String(err))
  } else {
    code = 'UNEXPECTED'
    message = err instanceof Error ? err.message : String(err)
  }

  if (format === 'json') {
    const errorObj: Record<string, unknown> = { code, message }
    if (hint !== undefined) errorObj.hint = hint
    write(JSON.stringify({ error: errorObj }) + '\n')
  } else {
    write(`error: ${message}\n`)
    if (hint !== undefined) write(`hint: ${hint}\n`)
  }

  return EXIT[code]
}
