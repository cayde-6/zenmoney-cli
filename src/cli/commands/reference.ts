import type { Command } from 'commander'
import type { AppContext } from '../context.js'
import { addFilterOptions, readFilters, withStore } from '../program.js'
import { categoryPath, loadDataset, meUser, type TxType } from '../../query/model.js'
import { applyFilters, currencyWarnings, ownerNameMatches, resolveFilterRefs, resolveOwner, resolveOwnerName, resolvePeriod, usedCurrencies } from '../../query/filters.js'
import { loadOwnersFile, ownersFilePath, entryMatchesAccount, type OwnersFile } from '../../query/owners.js'
import { flattenTxTable } from '../output.js'
import type { TableRow } from '../output.js'
import { ZmError } from '../../errors.js'
import { compareNames } from '../../util.js'
import type { ZmAccount } from '../../api/types.js'

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

// Flattens `zm owners` for `--format table`: one row per (owner, account)
// pair, plus one row per unassigned account with a literal '(unassigned)'
// owner — the nested `{ owners: [...], unassigned: [...] }` shape would
// otherwise fail the "flat object array" check and fall back to a raw JSON
// dump.
function flattenOwnersTable(
  owners: { name: string; accounts: { id: string; title: string }[] }[],
  unassigned: { id: string; title: string }[],
): TableRow[] {
  const rows: TableRow[] = []
  for (const o of owners) {
    for (const a of o.accounts) rows.push({ owner: o.name, id: a.id, title: a.title })
  }
  for (const a of unassigned) rows.push({ owner: '(unassigned)', id: a.id, title: a.title })
  return rows
}

// `zm owners`-only warnings about the quality of owners.yaml's own entries
// (as opposed to matchOwners' warnings about a real matching conflict):
// an entry that matches nothing is almost always a typo or a renamed/closed
// account, and an entry that matches most of the account list is likely
// too broad to mean what its author intended. Always computed over EVERY
// account (archived included), independent of `--archived`, since matching
// itself never depends on that flag either.
function entryMatchWarnings(file: OwnersFile, accounts: ZmAccount[]): string[] {
  const warnings: string[] = []
  const total = accounts.length
  for (const [name, entries] of file.owners) {
    for (const entry of entries) {
      const matched = accounts.filter(a => entryMatchesAccount(entry, a)).length
      if (matched === 0) {
        warnings.push(`entry "${entry}" of owner ${name} matches no accounts`)
      } else if (total > 0 && matched > total / 2) {
        warnings.push(`entry "${entry}" of owner ${name} matches ${matched} of ${total} accounts`)
      }
    }
  }
  return warnings
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
      // A family-member owner NAME (owners.yaml) has no natural mapping onto
      // ZenMoney's own user list — that mismatch is exactly why owners.yaml
      // exists for accounts/tx — so `users` rejects any non-'all' --owner
      // once the file is active, the same way categories/rates reject it
      // outright, rather than silently keeping the old me/login/id semantics
      // as if owners.yaml didn't change anything. Checked before opening the
      // cache alongside the file read, so it fails the same way regardless
      // of whether a cache exists.
      if (loadOwnersFile(ctx.paths.configDir) !== null && cmd.optsWithGlobals().owner !== 'all') {
        throw new ZmError('INVALID_ARGS', '--owner is not supported by users', 'owners.yaml is active; zm users lists ZenMoney users -- use zm owners')
      }
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
        const ds = loadDataset(store, loadOwnersFile(ctx.paths.configDir), ownersFilePath(ctx.paths.configDir))
        const loginOf = (userId: number) => ds.users.find(u => u.id === userId)?.login ?? String(userId)
        // Once owners.yaml exists, `owner` reports the file's owner name (or
        // null when unassigned) instead of the ZenMoney login, and --owner
        // filters by that name/unassigned/all instead of by ZenMoney user.
        const ownerOf = (a: ZmAccount): string | null => ds.ownerNames !== null ? (ds.ownerOf.get(a.id) ?? null) : loginOf(a.user)
        // Resolved once, unconditionally, up front — NOT lazily inside the
        // per-account filter predicate below. A version that resolved
        // --owner only when the predicate actually ran could skip
        // validation entirely whenever every account got filtered out by
        // something else first (e.g. --archived not passed and every
        // account happens to be archived), silently returning an empty
        // list with exit 0 instead of failing on a bad --owner value.
        const ownerValue = cmd.optsWithGlobals().owner
        const legacyOwnerIds = ds.ownerNames === null ? resolveOwner(ds, ownerValue) : null
        const resolvedOwnerName = ds.ownerNames !== null ? resolveOwnerName(ds.ownerNames, ds.ownersPath ?? 'owners.yaml', ownerValue) : null
        const matchesOwnerFilter = (a: ZmAccount): boolean =>
          resolvedOwnerName !== null
            ? ownerNameMatches(resolvedOwnerName, ds.ownerOf.get(a.id) ?? null)
            : (legacyOwnerIds === null || legacyOwnerIds.has(a.user))
        const data = [...ds.accounts.values()]
          .filter(a => opts.archived || !a.archive)
          .filter(matchesOwnerFilter)
          .map(a => ({
            id: a.id,
            title: a.title,
            type: a.type,
            currency: a.instrument !== null ? (ds.instruments.get(a.instrument)?.shortTitle ?? null) : null,
            balance: a.balance,
            inBalance: a.inBalance,
            archived: a.archive,
            owner: ownerOf(a),
          }))
          .sort((a, b) => compareNames(a.title, b.title))
        return { data, warnings: ds.ownerWarnings }
      })
    })

  program.command('owners')
    .description('List owners.yaml and which accounts each owner maps to (no network)')
    .option('--archived', 'include archived accounts')
    .addHelpText('after', '\nExamples:\n  zm owners\n  zm owners --archived\n')
    .action((opts, cmd) => {
      rejectOwner(cmd, 'owners')
      withStore(ctx, cmd, store => {
        const filePath = ownersFilePath(ctx.paths.configDir)
        const ownersFile = loadOwnersFile(ctx.paths.configDir)
        const ds = loadDataset(store, ownersFile, filePath)
        const toRef = (a: ZmAccount): { id: string; title: string } => ({ id: a.id, title: a.title })
        const accountsList = [...ds.accounts.values()].filter(a => opts.archived || !a.archive)

        if (ownersFile === null) {
          const data: { file: string | null; owners: { name: string; accounts: { id: string; title: string }[] }[]; unassigned: { id: string; title: string }[] } =
            { file: null, owners: [], unassigned: accountsList.map(toRef) }
          return {
            data,
            table: flattenOwnersTable([], accountsList),
            warnings: [`no owners.yaml found — create ${filePath} to split accounts by family member (see README's Owners section)`],
          }
        }

        const owners = ds.ownerNames!.map(name => ({
          name,
          accounts: accountsList.filter(a => ds.ownerOf.get(a.id) === name).map(toRef),
        }))
        const unassigned = accountsList.filter(a => !ds.ownerOf.has(a.id)).map(toRef)
        // Every account (archived included — matching itself always
        // considers archived accounts; --archived only ever affects what's
        // *displayed*) is used for these entry-quality warnings, so they
        // don't fluctuate depending on whether --archived was passed.
        const warnings = [...ds.ownerWarnings, ...entryMatchWarnings(ownersFile, [...ds.accounts.values()])]
        return {
          data: { file: filePath as string | null, owners, unassigned },
          table: flattenOwnersTable(owners, unassigned),
          ...(warnings.length ? { warnings } : {}),
        }
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
        const ds = loadDataset(store, loadOwnersFile(ctx.paths.configDir), ownersFilePath(ctx.paths.configDir))
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
          warnings: [...currencyWarnings(ds, filters.currency), ...ds.ownerWarnings],
        }
      })
    })
}
