import type { Command } from 'commander'
import type { AppContext } from '../context.js'
import { addFilterOptions, readFilters, withStore } from '../program.js'
import { flattenGroups } from '../output.js'
import { loadDataset } from '../../query/model.js'
import { applyFilters, currencyWarnings, resolveAccount, resolveCategory, resolvePeriod } from '../../query/filters.js'
import { spendBy, incomeBy, type SpendBy } from '../../analytics/spend.js'
import { compare, parsePeriod } from '../../analytics/compare.js'
import { findRecurring, recurringWindow } from '../../analytics/recurring.js'
import { ZmError } from '../../errors.js'

const SPEND_BY: SpendBy[] = ['category', 'month', 'merchant']
const INCOME_BY: Array<'category' | 'month'> = ['category', 'month']
const COMPARE_BY: Array<'total' | 'category'> = ['total', 'category']

export function registerAnalytics(program: Command, ctx: AppContext): void {
  addFilterOptions(program.command('spend'))
    .description('Spend grouped by category, month, or merchant')
    .requiredOption('--by <field>', 'category | month | merchant')
    .option('--tree', 'group category results as a parent/children tree (category only)')
    .addHelpText('after', '\nExamples:\n  zm spend --by category --month 2026-09\n  zm spend --by month --from 2026-01-01 --category Продукты --owner me\n  zm spend --by merchant --month 2026-09 --currency PLN --format table\n')
    .action((opts, cmd) => {
      // Option-shape checks first, before withStore's cache check: a bad --by or
      // an invalid period is wrong regardless of whether a cache exists.
      if (!SPEND_BY.includes(opts.by)) {
        throw new ZmError('INVALID_ARGS', `unknown --by: ${opts.by}`, `valid: ${SPEND_BY.join(', ')}`)
      }
      if (opts.tree && opts.by !== 'category') {
        throw new ZmError('INVALID_ARGS', '--tree is only valid with --by category')
      }
      const filters = readFilters(cmd)
      const period = resolvePeriod(filters)

      withStore(ctx, cmd, store => {
        const ds = loadDataset(store)
        const category = filters.category ? resolveCategory(ds, filters.category).path : null
        const account = filters.account ? resolveAccount(ds, filters.account).id : null
        const txs = applyFilters(ds, filters)
        const data = spendBy(txs, opts.by as SpendBy, { tree: opts.tree, tags: ds.tags })

        return {
          data,
          table: flattenGroups(data),
          meta: {
            by: opts.by, from: period.from, to: period.to, category,
            owner: cmd.optsWithGlobals().owner, account, currency: filters.currency ?? null,
          },
          warnings: currencyWarnings(ds, filters.currency),
        }
      })
    })

  addFilterOptions(program.command('income'))
    .description('Income grouped by category or month')
    .requiredOption('--by <field>', 'category | month')
    .addHelpText('after', '\nExamples:\n  zm income --by category --month 2026-09\n  zm income --by month --owner me\n')
    .action((opts, cmd) => {
      if (!INCOME_BY.includes(opts.by)) {
        throw new ZmError('INVALID_ARGS', `unknown --by: ${opts.by}`, `valid: ${INCOME_BY.join(', ')}`)
      }
      const filters = readFilters(cmd)
      const period = resolvePeriod(filters)

      withStore(ctx, cmd, store => {
        const ds = loadDataset(store)
        const category = filters.category ? resolveCategory(ds, filters.category).path : null
        const account = filters.account ? resolveAccount(ds, filters.account).id : null
        const txs = applyFilters(ds, filters)
        const data = incomeBy(txs, opts.by as 'category' | 'month')

        return {
          data,
          table: flattenGroups(data),
          meta: {
            by: opts.by, from: period.from, to: period.to, category,
            owner: cmd.optsWithGlobals().owner, account, currency: filters.currency ?? null,
          },
          warnings: currencyWarnings(ds, filters.currency),
        }
      })
    })

  program.command('compare')
    .description('Compare spend between two periods')
    .option('--category <query>', 'category path, id, or unique leaf title')
    .option('--account <query>', 'account id, or unique title substring')
    .option('--currency <code>', 'filter by primary-side currency')
    .requiredOption('--period <p>', 'YYYY-MM, or YYYY-MM-DD..YYYY-MM-DD')
    .requiredOption('--vs <p>', 'YYYY-MM, or YYYY-MM-DD..YYYY-MM-DD, to compare against')
    .option('--by <field>', 'total | category', 'total')
    .addHelpText('after', '\nExamples:\n  zm compare --period 2026-09 --vs 2026-08\n  zm compare --period 2026-09 --vs 2026-08 --by category\n  zm compare --period 2026-01-01..2026-01-15 --vs 2025-01-01..2025-01-15\n')
    .action((opts, cmd) => {
      if (!COMPARE_BY.includes(opts.by)) {
        throw new ZmError('INVALID_ARGS', `unknown --by: ${opts.by}`, `valid: ${COMPARE_BY.join(', ')}`)
      }
      const periodRange = parsePeriod(opts.period)
      const vsRange = parsePeriod(opts.vs)
      const filters = readFilters(cmd)

      withStore(ctx, cmd, store => {
        const ds = loadDataset(store)
        const periodTxs = applyFilters(ds, { ...filters, ...periodRange })
        const vsTxs = applyFilters(ds, { ...filters, ...vsRange })
        const data = compare(periodTxs, vsTxs, opts.by as 'total' | 'category')
        const category = filters.category ? resolveCategory(ds, filters.category).path : null
        const account = filters.account ? resolveAccount(ds, filters.account).id : null

        return {
          data,
          table: data as unknown as Array<Record<string, string | number | null>>,
          meta: {
            by: opts.by, period: opts.period, vs: opts.vs,
            category, account, currency: filters.currency ?? null, owner: cmd.optsWithGlobals().owner,
          },
          warnings: currencyWarnings(ds, filters.currency),
        }
      })
    })

  // No --from/--to/--month: the window is derived from `now`, not an explicit period.
  program.command('recurring')
    .description('Detect recurring payments / subscriptions')
    .option('--months <n>', 'window size in months', '6')
    .option('--min-months <n>', 'minimum distinct months to qualify', '3')
    .option('--category <query>', 'category path, id, or unique leaf title')
    .option('--account <query>', 'account id, or unique title substring')
    .option('--currency <code>', 'filter by primary-side currency')
    .addHelpText('after', '\nExamples:\n  zm recurring\n  zm recurring --months 12 --min-months 4\n  zm recurring --category Подписки\n')
    .action((opts, cmd) => {
      const months = Number(opts.months)
      if (!Number.isInteger(months) || months < 1 || months > 36) {
        throw new ZmError('INVALID_ARGS', `invalid --months: ${opts.months}`, 'use an integer 1..36')
      }
      const minMonths = Number(opts.minMonths)
      if (!Number.isInteger(minMonths) || minMonths < 1 || minMonths > months) {
        throw new ZmError('INVALID_ARGS', `invalid --min-months: ${opts.minMonths}`, `use an integer 1..${months}`)
      }
      const filters = readFilters(cmd)

      withStore(ctx, cmd, store => {
        const ds = loadDataset(store)
        const txs = applyFilters(ds, filters)
        const now = ctx.now()
        const data = findRecurring(txs, { months, now, minMonths })
        const window = recurringWindow(months, now)
        const category = filters.category ? resolveCategory(ds, filters.category).path : null
        const account = filters.account ? resolveAccount(ds, filters.account).id : null

        return {
          data,
          table: data as unknown as Array<Record<string, string | number | null>>,
          meta: {
            months, minMonths, from: window.from, to: window.to,
            category, account, currency: filters.currency ?? null, owner: cmd.optsWithGlobals().owner,
          },
          warnings: currencyWarnings(ds, filters.currency),
        }
      })
    })
}
