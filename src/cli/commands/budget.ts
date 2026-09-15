import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import type { Command } from 'commander'
import type { AppContext } from '../context.js'
import { withStore, staleWarnings, formatOf, openCheckedStore } from '../program.js'
import { categoryPath, loadDataset, meUser } from '../../query/model.js'
import { applyFilters, isValidMonth } from '../../query/filters.js'
import { loadBudget } from '../../budget/files.js'
import { budgetStatus, unresolvedLimits, type BudgetStatus, type StatusRow } from '../../budget/status.js'
import { suggestBudget, suggestWindow } from '../../budget/suggest.js'
import { addMonths, compareNames, localMonth } from '../../util.js'
import { ZmError } from '../../errors.js'
import { ensureDirMode } from '../../fsutil.js'

function validateMonth(s: string): void {
  if (!isValidMonth(s)) throw new ZmError('INVALID_ARGS', `invalid month: ${s}`, 'use YYYY-MM')
}

function formatOtherCurrencies(other: StatusRow['spentOtherCurrencies']): string {
  return other.map(o => `${o.currency} ${o.amount}`).join(', ')
}

function flattenStatusTable(status: BudgetStatus): Array<Record<string, string | number | null>> {
  const rows: Array<Record<string, string | number | null>> = status.rows.map(r => ({
    category: r.category, currency: r.currency, planned: r.planned, spent: r.spent,
    remaining: r.remaining, usedPct: r.usedPct, pace: r.pace,
    otherCurrencies: formatOtherCurrencies(r.spentOtherCurrencies),
  }))
  for (const g of status.unplanned) {
    for (const a of g.amounts) {
      rows.push({
        category: g.key, currency: a.currency, planned: '-', spent: a.amount,
        remaining: '-', usedPct: '-', pace: '-', otherCurrencies: '',
      })
    }
  }
  return rows
}

export function registerBudget(program: Command, ctx: AppContext): void {
  const budget = program.command('budget').description('Local yaml budget: template + month overrides')

  budget.command('init')
    .description('Write a budget template from current expense-capable categories')
    .option('--force', 'overwrite an existing default.yaml')
    .addHelpText('after', '\nExamples:\n  zm budget init\n  zm budget init --force\n')
    .action((opts, cmd) => {
      withStore(ctx, cmd, store => {
        const file = join(ctx.paths.budgetDir, 'default.yaml')
        if (existsSync(file) && !opts.force) {
          throw new ZmError('INVALID_ARGS', `budget file already exists: ${file}`, 'use --force to overwrite')
        }

        const ds = loadDataset(store)
        const currency = ds.instruments.get(meUser(ds).currency)?.shortTitle
        if (currency === undefined) {
          throw new ZmError('NO_CACHE', 'cannot determine main currency', 'run zm sync --full')
        }
        // Categories that can carry an expense: pure-expense tags and
        // both-income-and-expense tags. Income-only tags are excluded.
        const expensePaths = [...ds.tags.values()]
          .filter(t => t.showOutcome)
          .map(t => categoryPath(t.id, ds.tags))
          .sort(compareNames)

        // Each commented line is indented as a `limits:` child and built via
        // yaml's own stringify, so uncommenting it (stripping the leading
        // `  # `) always yields a valid nested yaml entry, even for a path
        // that would otherwise need quoting (e.g. one containing ": ").
        const lines = [
          `currency: ${currency}`,
          'limits:',
          ...expensePaths.map(p => `  # ${stringify({ [p]: 0 }).trim()}`),
        ]
        // Both the config dir itself and the budget dir nested under it need
        // to end up at 0700: mkdirSync's `recursive: true` (inside
        // ensureDirMode) silently creates configDir along the way at the
        // process's default umask, and chmodding only the leaf (budgetDir)
        // would leave that ancestor at whatever the umask happened to be.
        ensureDirMode(ctx.paths.configDir, 0o700, ctx.platform)
        ensureDirMode(ctx.paths.budgetDir, 0o700, ctx.platform)
        writeFileSync(file, lines.join('\n') + '\n')

        return { data: { file } }
      })
    })

  budget.command('status')
    .description('Plan vs fact for a budget month')
    .option('--month <month>', 'YYYY-MM, defaults to the current month')
    .addHelpText('after', '\nExamples:\n  zm budget status\n  zm budget status --month 2026-10\n')
    .action((opts, cmd) => {
      if (opts.month !== undefined) validateMonth(opts.month)
      withStore(ctx, cmd, store => {
        const month = opts.month ?? localMonth(ctx.now())
        const owner = cmd.optsWithGlobals().owner

        const ds = loadDataset(store)
        const { limits, sources, keySources } = loadBudget(ctx.paths.budgetDir, month)
        const { resolvable, unresolved, warnings } = unresolvedLimits(ds, limits, keySources)
        const monthTxs = applyFilters(ds, { month, owner })
        const data = budgetStatus(ds, resolvable, monthTxs, month, ctx.now(), unresolved)

        return { data, meta: { sources, owner }, table: flattenStatusTable(data), warnings }
      })
    })

  budget.command('suggest')
    .description('Suggest a draft budget from historical spend (prints yaml)')
    .option('--months <n>', 'trailing months to sample', '3')
    .option('--month <month>', 'target month, YYYY-MM, defaults to next month')
    .addHelpText('after', '\nExamples:\n  zm budget suggest\n  zm budget suggest --months 6 --month 2026-11 > draft.yaml\n')
    .action((opts, cmd) => {
      // Output is always raw yaml, never a table, but an unrecognised --format is
      // still a user mistake worth catching — formatOf throws INVALID_ARGS for
      // anything but json/table; its return value is otherwise unused here.
      formatOf(cmd)
      const months = Number(opts.months)
      if (!Number.isInteger(months) || months < 1) {
        throw new ZmError('INVALID_ARGS', `invalid --months: ${opts.months}`, 'use an integer >= 1')
      }
      if (opts.month !== undefined) validateMonth(opts.month)
      const targetMonth = opts.month ?? addMonths(localMonth(ctx.now()), 1)

      const store = openCheckedStore(ctx)
      try {
        const ds = loadDataset(store)
        const owner = cmd.optsWithGlobals().owner
        const txs = applyFilters(ds, { owner })
        const window = suggestWindow(targetMonth, months, ctx.now())
        const mainCurrency = ds.instruments.get(meUser(ds).currency)?.shortTitle
        if (mainCurrency === undefined) {
          throw new ZmError('NO_CACHE', 'cannot determine main currency', 'run zm sync --full')
        }
        const text = suggestBudget(txs, window, targetMonth, mainCurrency)

        const { lastSyncAt } = store.getMeta()
        for (const w of staleWarnings(ctx, lastSyncAt)) ctx.stderr(`warning: ${w}\n`)
        ctx.stdout(text)
      } finally {
        store.close()
      }
    })
}
