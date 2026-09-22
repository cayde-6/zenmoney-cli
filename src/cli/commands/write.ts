// `zm edit`/`zm add`/`zm delete`: parses and validates flags, resolves
// categories/accounts, builds a Planner (src/write/apply.ts's `Planner`
// type) and hands it to `runWrite`, which does the actual dry-run/--apply
// I/O. This module owns everything runWrite doesn't: flag-shape validation
// (before the cache is opened -- see docs/superpowers/specs/
// 2026-09-22-tx-write-mode-design.md's "Errors"), target lookup by id, and
// category/account resolution (both need the Dataset, so they happen
// inside the Planner closures below, not here).
import type { Command } from 'commander'
import type { AppContext } from '../context.js'
import { formatOf } from '../program.js'
import { runWrite, RERUN_HINT, type Planner } from '../../write/apply.js'
import { planEdit, planAdd, planDelete, parseAmount, isApplied, UUID_RE, type EditFields, type AddInput, type PlannedChange } from '../../write/plan.js'
import { resolveCategory, resolveAccount, isValidDate } from '../../query/filters.js'
import { ZmError } from '../../errors.js'
import type { ZmTransaction } from '../../api/types.js'

function requireOwnerAll(cmd: Command, name: string): void {
  if (cmd.optsWithGlobals().owner !== 'all') {
    throw new ZmError('INVALID_ARGS', `--owner is not supported by ${name}`)
  }
}

function checkApplyExpect(opts: { apply?: boolean; expect?: string }): void {
  if (opts.apply && !opts.expect) {
    throw new ZmError('INVALID_ARGS', '--apply requires --expect <token>', 'run the command without --apply first and use the applyCommand it prints')
  }
}

function checkNoDuplicateIds(ids: string[]): void {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id)
    seen.add(id)
  }
  if (dupes.size > 0) throw new ZmError('INVALID_ARGS', `duplicate transaction id: ${[...dupes].join(', ')}`)
}

// `--category`/`--account` accept "" as INVALID_ARGS (there is no sensible
// "clear" for either), unlike --comment/--payee, where "" is a valid value
// meaning "clear this field" -- so those two are never checked here.
function requireNonEmpty(value: string | undefined, flag: string): void {
  if (value !== undefined && value.trim() === '') {
    throw new ZmError('INVALID_ARGS', `--${flag} must not be empty`)
  }
}

// `add`'s default --date: the *local* calendar date of ctx.now(), not
// toISOString's UTC date -- see the design spec's `zm add` section. Resolved
// once per invocation and folded into the reconstructed argv so a retried
// --apply always uses the same date even if it is run after local midnight.
function localDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function registerWrite(program: Command, ctx: AppContext): void {
  program.command('edit <ids...>')
    .description('Edit one or more transactions (dry-run by default; rerun the printed applyCommand to write)')
    .option('--comment <text>', 'set comment; "" clears it')
    .option('--payee <text>', 'set payee (also clears any linked merchant); "" clears it')
    .option('--category <query>', 'category path, id, or unique leaf title')
    .option('--date <date>', 'YYYY-MM-DD')
    .option('--amount <n>', 'new amount (single-currency simple transactions only)')
    .option('--account <query>', 'move to a different account, same currency (single-currency simple transactions only)')
    .option('--apply', 'write the plan shown by a previous dry-run')
    .option('--expect <token>', 'the plan token printed by the dry-run being applied')
    .addHelpText('after', '\nExamples:\n  zm edit t1 --comment Netflix\n  zm edit t1 t2 --category Groceries\n  zm edit t1 --comment Netflix --apply --expect 9f2c1a3b4d5e6f70\n')
    .action(async (ids: string[], opts, cmd) => {
      requireOwnerAll(cmd, 'edit')
      checkApplyExpect(opts)
      checkNoDuplicateIds(ids)
      requireNonEmpty(opts.category, 'category')
      requireNonEmpty(opts.account, 'account')

      const hasField = opts.comment !== undefined || opts.payee !== undefined || opts.category !== undefined
        || opts.date !== undefined || opts.amount !== undefined || opts.account !== undefined
      if (!hasField) {
        throw new ZmError('INVALID_ARGS', 'edit needs at least one field flag', '--comment, --payee, --category, --date, --amount, or --account')
      }

      if (opts.date !== undefined && !isValidDate(opts.date)) {
        throw new ZmError('INVALID_ARGS', `invalid --date: ${opts.date}`, 'use YYYY-MM-DD')
      }
      const amount = opts.amount !== undefined ? parseAmount(opts.amount, '--amount') : undefined

      const format = formatOf(cmd)
      const argv: string[] = ['edit', ...ids]
      if (opts.comment !== undefined) argv.push('--comment', opts.comment)
      if (opts.payee !== undefined) argv.push('--payee', opts.payee)
      if (opts.category !== undefined) argv.push('--category', opts.category)
      if (opts.date !== undefined) argv.push('--date', opts.date)
      if (opts.amount !== undefined) argv.push('--amount', opts.amount)
      if (opts.account !== undefined) argv.push('--account', opts.account)
      if (format === 'table') argv.push('--format', 'table')

      const plan: Planner = (store, ds, { postSync }) => {
        const missing: string[] = []
        const alreadyDeleted: string[] = []
        const targets: ZmTransaction[] = []
        for (const id of ids) {
          const t = store.getTransaction(id)
          if (t === null) missing.push(id)
          else if (t.deleted) alreadyDeleted.push(id)
          else targets.push(t)
        }
        if (postSync) {
          if (missing.length > 0 || alreadyDeleted.length > 0) {
            throw new ZmError('CONFLICT', 'transaction was deleted or is gone', [...missing, ...alreadyDeleted].join(', '))
          }
        } else {
          // Two separate checks, unknown ids first: a never-synced id is a
          // plain mistake (INVALID_ARGS "unknown"), while a present-but-
          // deleted one gets its own, more specific message -- they are
          // never merged into one, so fixing the first kind doesn't hide
          // the second kind still waiting on a rerun.
          if (missing.length > 0) {
            throw new ZmError('INVALID_ARGS', `unknown transaction id: ${missing.join(', ')}`, 'check the id, e.g. from zm tx')
          }
          if (alreadyDeleted.length > 0) {
            throw new ZmError('INVALID_ARGS', `already deleted: ${alreadyDeleted.join(', ')}`, 'nothing to edit')
          }
        }

        const fields: EditFields = {}
        if (opts.comment !== undefined) fields.comment = opts.comment
        if (opts.payee !== undefined) fields.payee = opts.payee
        if (opts.category !== undefined) fields.categoryId = resolveCategory(ds, opts.category).id
        if (opts.date !== undefined) fields.date = opts.date
        if (amount !== undefined) fields.amount = amount
        if (opts.account !== undefined) fields.accountId = resolveAccount(ds, opts.account).id
        return planEdit(ds, targets, fields)
      }

      await runWrite(ctx, { format, argv, apply: Boolean(opts.apply), expect: opts.expect, plan })
    })

  program.command('add')
    .description('Add a new transaction (dry-run by default; rerun the printed applyCommand to write)')
    .option('--expense <n>', 'amount spent (exactly one of --expense/--income)')
    .option('--income <n>', 'amount received (exactly one of --expense/--income)')
    .option('--account <query>', 'account id, or unique title substring (required)')
    .option('--category <query>', 'category path, id, or unique leaf title')
    .option('--date <date>', 'YYYY-MM-DD (default: today)')
    .option('--comment <text>', 'comment')
    .option('--payee <text>', 'payee')
    .option('--id <uuid>', 'transaction id; generated if omitted (required with --apply)')
    .option('--apply', 'write the plan shown by a previous dry-run')
    .option('--expect <token>', 'the plan token printed by the dry-run being applied')
    .addHelpText('after', '\nExamples:\n  zm add --expense 12.50 --account "Card PLN" --category Groceries\n  zm add --income 500 --account "Cash EUR" --comment Freelance\n')
    .action(async (opts, cmd) => {
      requireOwnerAll(cmd, 'add')
      checkApplyExpect(opts)

      if ((opts.expense === undefined) === (opts.income === undefined)) {
        throw new ZmError('INVALID_ARGS', 'add needs exactly one of --expense or --income')
      }
      if (opts.account === undefined) {
        throw new ZmError('INVALID_ARGS', '--account is required')
      }
      requireNonEmpty(opts.category, 'category')
      requireNonEmpty(opts.account, 'account')

      if (opts.apply && opts.id === undefined) {
        throw new ZmError('INVALID_ARGS', '--apply requires --id <uuid>', 'run the command without --apply first and use the applyCommand it prints')
      }
      // Lowercased before validating/using it, so an upper-case (or mixed-
      // case) --id still matches UUID_RE, and every later use -- the plan,
      // the rebuilt argv, the printed applyCommand -- sees the same
      // canonical form a retried --apply would also produce.
      if (opts.id !== undefined) opts.id = opts.id.toLowerCase()
      if (opts.id !== undefined && !UUID_RE.test(opts.id)) {
        throw new ZmError('INVALID_ARGS', `invalid --id: ${opts.id}`, 'must be a UUID, e.g. 3b67e2c0-1234-4abc-9def-1234567890ab')
      }

      const kind: 'expense' | 'income' = opts.expense !== undefined ? 'expense' : 'income'
      const rawAmount: string = opts.expense !== undefined ? opts.expense : opts.income
      const amountFlag = opts.expense !== undefined ? '--expense' : '--income'
      const amount = parseAmount(rawAmount, amountFlag)

      if (opts.date !== undefined && !isValidDate(opts.date)) {
        throw new ZmError('INVALID_ARGS', `invalid --date: ${opts.date}`, 'use YYYY-MM-DD')
      }
      const date = opts.date ?? localDate(ctx.now())
      const id: string = opts.id ?? ctx.uuid()

      const format = formatOf(cmd)
      const argv: string[] = ['add', amountFlag, rawAmount, '--account', opts.account]
      if (opts.category !== undefined) argv.push('--category', opts.category)
      argv.push('--date', date)
      if (opts.comment !== undefined) argv.push('--comment', opts.comment)
      if (opts.payee !== undefined) argv.push('--payee', opts.payee)
      if (format === 'table') argv.push('--format', 'table')
      argv.push('--id', id)

      const plan: Planner = (store, ds) => {
        const accountId = resolveAccount(ds, opts.account).id
        const categoryId = opts.category !== undefined ? resolveCategory(ds, opts.category).id : undefined
        const input: AddInput = { id, kind, amount, accountId, categoryId, date, comment: opts.comment, payee: opts.payee }
        const changes = planAdd(ds, input)
        const existing = store.getTransaction(id)
        if (existing !== null && !isApplied(changes[0]!, existing)) {
          throw new ZmError('CONFLICT', `transaction ${id} already exists with different content`, RERUN_HINT)
        }
        return changes
      }

      await runWrite(ctx, { format, argv, apply: Boolean(opts.apply), expect: opts.expect, plan })
    })

  program.command('delete <ids...>')
    .description('Delete one or more transactions (dry-run by default; rerun the printed applyCommand to write)')
    .option('--apply', 'write the plan shown by a previous dry-run')
    .option('--expect <token>', 'the plan token printed by the dry-run being applied')
    .addHelpText('after', '\nExamples:\n  zm delete t1\n  zm delete t1 t2 --apply --expect 9f2c1a3b4d5e6f70\n')
    .action(async (ids: string[], opts, cmd) => {
      requireOwnerAll(cmd, 'delete')
      checkApplyExpect(opts)
      checkNoDuplicateIds(ids)

      const format = formatOf(cmd)
      const argv: string[] = ['delete', ...ids]
      if (format === 'table') argv.push('--format', 'table')

      const plan: Planner = (store, _ds, { postSync }) => {
        if (!postSync) {
          const missing = ids.filter(id => store.getTransaction(id) === null)
          if (missing.length > 0) {
            throw new ZmError('INVALID_ARGS', `unknown transaction id: ${missing.join(', ')}`, 'check the id, e.g. from zm tx')
          }
          // A present-but-already-deleted target is not rejected here --
          // it is planned like any other target. runWrite's own
          // isApplied-based filtering (splitPending) drops it before the
          // token is computed and reports it via the "already in that
          // state"/"nothing to change" warnings, exactly the way an edit
          // target that already matches the requested state is handled.
          return planDelete(ids.map(id => store.getTransaction(id)!))
        }
        // Post-sync: a target the sync found gone outright (no row left in
        // the cache at all) gets a synthetic already-applied marker. `next`
        // must itself carry `deleted: true` -- balanceImpact's
        // contribution() checks `t.deleted` before reading any other field,
        // so a bare `{ id }` (missing `deleted`) fell through into reading
        // undefined income/outcome/account fields and produced a bogus
        // balanceImpact entry; changeViews never emits a `raw: null` key for
        // this case either, since it only adds `raw` when `base` is
        // non-null, and this synthetic change's `base` is null. A target the
        // sync still finds present (deleted or not) goes through planDelete
        // normally; isApplied drops an already-deleted one the same way
        // once splitPending looks it up again.
        return ids.map((id): PlannedChange => {
          const t = store.getTransaction(id)
          if (t === null) return { op: 'delete', id, base: null, next: { id, deleted: true } as ZmTransaction, set: {} }
          return planDelete([t])[0]!
        })
      }

      await runWrite(ctx, { format, argv, apply: Boolean(opts.apply), expect: opts.expect, plan })
    })
}
