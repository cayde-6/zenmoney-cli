import type { Command } from 'commander'
import type { AppContext } from '../context.js'
import { addFilterOptions, readFilters, withStore } from '../program.js'
import { categoryPath, loadDataset, meUser, type TxType } from '../../query/model.js'
import { applyFilters, currencyWarnings, resolveFilterRefs, resolveOwner, resolvePeriod, usedCurrencies } from '../../query/filters.js'
import { flattenTxTable } from '../output.js'
import { ZmError } from '../../errors.js'
import { compareNames } from '../../util.js'

const TX_TYPES: TxType[] = ['expense', 'income', 'refund', 'transfer', 'debt']

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

function parseTypes(raw: string | undefined): TxType[] | undefined {
  if (raw === undefined) return undefined
  const types = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (types.length === 0) throw new ZmError('INVALID_ARGS', `empty --type list: ${raw}`, `valid types: ${TX_TYPES.join(', ')}`)
  for (const t of types) {
    if (!(TX_TYPES as string[]).includes(t)) {
      throw new ZmError('INVALID_ARGS', `unknown type: ${t}`, `valid types: ${TX_TYPES.join(', ')}`)
    }
  }
  return types as TxType[]
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 100
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new ZmError('INVALID_ARGS', `invalid limit: ${raw}`, 'must be a positive integer')
  return n
}

// categories and rates have no per-owner concept of their own (a category or an
// exchange rate isn't owned by anyone) — reject the global --owner explicitly
// rather than silently ignoring it, since ignoring it would look like it worked.
function rejectOwner(cmd: Command, name: string): void {
  const owner = cmd.optsWithGlobals().owner
  if (owner !== 'all') throw new ZmError('INVALID_ARGS', `--owner is not supported by ${name}`)
}

function kindOfTag(tag: { showIncome: boolean; showOutcome: boolean }): 'expense' | 'income' | 'both' {
  if (tag.showOutcome && !tag.showIncome) return 'expense'
  if (tag.showIncome && !tag.showOutcome) return 'income'
  return 'both'
}

interface CategoryRow { id: string; path: string; parentId: string | null; kind: string }

// Flattens `categories --tree` for `--format table`: the nested `children`
// array would otherwise fail the "flat object array" check and fall back to a
// raw JSON dump. Child rows get their path indented two spaces, same
// convention as flattenGroups' child rows.
function flattenCategoryTree(tree: Array<CategoryRow & { children: CategoryRow[] }>): Array<Record<string, string | number | null>> {
  const rows: Array<Record<string, string | number | null>> = []
  for (const c of tree) {
    rows.push({ id: c.id, path: c.path, parentId: c.parentId, kind: c.kind })
    for (const child of c.children) {
      rows.push({ id: child.id, path: '  ' + child.path, parentId: child.parentId, kind: child.kind })
    }
  }
  return rows
}

export function registerReference(program: Command, ctx: AppContext): void {
  program.command('users')
    .description('List ZenMoney users on this account')
    .addHelpText('after', '\nExamples:\n  zm users\n  zm users --format table\n')
    .action((_opts, cmd) => {
      withStore(ctx, cmd, store => {
        const ds = loadDataset(store)
        const ownerIds = resolveOwner(ds, cmd.optsWithGlobals().owner)
        const data = ds.users
          .filter(u => ownerIds === null || ownerIds.has(u.id))
          .map(u => ({
            id: u.id,
            login: u.login,
            currency: ds.instruments.get(u.currency)?.shortTitle ?? null,
            isMain: u.parent === null,
          }))
        return { data }
      })
    })

  program.command('accounts')
    .description('List accounts')
    .option('--archived', 'include archived accounts')
    .addHelpText('after', '\nExamples:\n  zm accounts\n  zm accounts --archived --owner me\n')
    .action((opts, cmd) => {
      withStore(ctx, cmd, store => {
        const ds = loadDataset(store)
        const ownerIds = resolveOwner(ds, cmd.optsWithGlobals().owner)
        const loginOf = (userId: number) => ds.users.find(u => u.id === userId)?.login ?? String(userId)
        const data = [...ds.accounts.values()]
          .filter(a => opts.archived || !a.archive)
          .filter(a => ownerIds === null || ownerIds.has(a.user))
          .map(a => ({
            id: a.id,
            title: a.title,
            type: a.type,
            currency: a.instrument !== null ? (ds.instruments.get(a.instrument)?.shortTitle ?? null) : null,
            balance: a.balance,
            inBalance: a.inBalance,
            archived: a.archive,
            owner: loginOf(a.user),
          }))
          .sort((a, b) => compareNames(a.title, b.title))
        return { data }
      })
    })

  program.command('categories')
    .description('List categories (tags)')
    .option('--tree', 'group as a parent/children tree')
    .addHelpText('after', '\nExamples:\n  zm categories\n  zm categories --tree\n')
    .action((opts, cmd) => {
      rejectOwner(cmd, 'categories')
      withStore(ctx, cmd, store => {
        const ds = loadDataset(store)
        const flat = [...ds.tags.values()]
          .map(t => ({ id: t.id, path: categoryPath(t.id, ds.tags), parentId: t.parent, kind: kindOfTag(t) }))
          .sort((a, b) => compareNames(a.path, b.path))

        if (!opts.tree) return { data: flat }

        // A tag whose parent id doesn't resolve to any known tag (a dangling
        // reference) is treated as top-level rather than silently dropped —
        // it would otherwise match neither the `parentId === null` top-level
        // check nor any real top's children filter, and vanish from the tree.
        const knownIds = new Set(flat.map(c => c.id))
        const top = flat.filter(c => c.parentId === null || !knownIds.has(c.parentId))
        const tree = top.map(c => ({ ...c, children: flat.filter(child => child.parentId === c.id) }))
        return { data: tree, table: flattenCategoryTree(tree) }
      })
    })

  program.command('rates')
    .description('Current exchange rates relative to the main user currency')
    .addHelpText('after', '\nExamples:\n  zm rates\n  zm rates --format table\n')
    .action((_opts, cmd) => {
      rejectOwner(cmd, 'rates')
      withStore(ctx, cmd, store => {
        const ds = loadDataset(store)
        const base = ds.instruments.get(meUser(ds).currency)
        if (!base) throw new ZmError('UNEXPECTED', 'main user currency instrument not found')

        const instrumentByShortTitle = new Map([...ds.instruments.values()].map(i => [i.shortTitle, i] as const))
        const data = [...usedCurrencies(ds)]
          .map(title => instrumentByShortTitle.get(title))
          .filter((i): i is NonNullable<typeof i> => i !== undefined)
          .map(i => ({ currency: i.shortTitle, rate: round6(i.rate / base.rate) }))
          .sort((a, b) => compareNames(a.currency, b.currency))

        return {
          data,
          meta: { base: base.shortTitle, note: 'current ZenMoney rates, not historical; use only for explicit estimates' },
        }
      })
    })

  addFilterOptions(program.command('tx'))
    .description('List transactions')
    .option('--type <types>', 'comma-separated: expense,income,refund,transfer,debt')
    .option('--search <text>', 'substring match on merchant, payee, comment, category')
    .option('--limit <n>', 'max results (default 100)')
    .addHelpText('after', '\nExamples:\n  zm tx --month 2026-09 --category Groceries\n  zm tx --type expense,refund --search Netflix --limit 20\n  zm tx --from 2026-01-01 --to 2026-01-31 --account "Card PLN"\n')
    .action((opts, cmd) => {
      // Option-shape checks first, before withStore's cache check.
      const filters = readFilters(cmd)
      filters.type = parseTypes(opts.type)
      filters.search = opts.search
      const limit = parseLimit(opts.limit)
      const period = resolvePeriod(filters)

      withStore(ctx, cmd, store => {
        const ds = loadDataset(store)
        const refs = resolveFilterRefs(ds, filters)
        const matched = applyFilters(ds, filters, refs)
        const data = matched.slice(0, limit)

        return {
          data,
          table: flattenTxTable(data),
          meta: {
            from: period.from,
            to: period.to,
            category: refs.categoryPath,
            owner: cmd.optsWithGlobals().owner,
            account: refs.accountId,
            currency: filters.currency ?? null,
            type: filters.type ?? null,
            search: filters.search ?? null,
            limit,
            total: matched.length,
            returned: data.length,
          },
          warnings: currencyWarnings(ds, filters.currency),
        }
      })
    })
}
