import { Command, CommanderError } from 'commander'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { AppContext } from './context.js'
import { printError, printResult, type Format, type TableRow } from './output.js'
import { ZmError } from '../errors.js'
import type { Store } from '../store/store.js'
import { registerSync } from './commands/sync.js'
import { registerReference } from './commands/reference.js'
import { registerAnalytics } from './commands/analytics.js'
import { registerBudget } from './commands/budget.js'
import { registerStatus } from './commands/status.js'
import type { Filters } from '../query/filters.js'

// Walks up from this file (dist/program-*.js when built, src/cli/program.ts in
// tests) to the package.json named @cayde-6/zenmoney-cli — that directory is
// the package root, alongside which SKILL.md and package.json itself live.
function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const pkgPath = path.join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      const require = createRequire(import.meta.url)
      const pkg = require(pkgPath) as { name?: string }
      if (pkg.name === '@cayde-6/zenmoney-cli') return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('package.json not found while resolving package root')
    dir = parent
  }
}

export function readVersion(): string {
  const require = createRequire(import.meta.url)
  const pkg = require(path.join(findPackageRoot(), 'package.json')) as { version?: string }
  return pkg.version ?? '0.0.0'
}

// Commander writes its own one-line "error: ..." message via writeErr right before
// throwing a CommanderError for validation failures (unknown command, excess
// arguments, etc.). We reformat those ourselves as a JSON/table error in run()'s
// catch block, so forwarding commander's raw copy too would duplicate it and,
// for --format json, break JSON parsing of stderr. Real help/usage text (e.g. a
// bare `zm` with subcommands registered, which commander also prints via writeErr
// when nothing else was wrong enough to have its own message) never starts with
// "error: ", so filtering on that prefix keeps it flowing to stderr without
// duplicating validation errors.
function writeErrUnlessHandledElsewhere(ctx: AppContext): (s: string) => void {
  return s => {
    if (!s.startsWith('error: ')) ctx.stderr(s)
  }
}

export function buildProgram(ctx: AppContext): Command {
  const program = new Command('zm')
    .description('Read-only ZenMoney CLI. Agents: see SKILL.md in the package root.')
    .version(readVersion(), '-V, --version')
    .option('--format <format>', 'json | table', 'json')
    .option('--owner <owner>', "me (main user of the family account, i.e. the user with no parent -- not necessarily the token holder) | all | user id | login", 'all')
    .addHelpText('after', `\nAgent guide: ${path.join(findPackageRoot(), 'SKILL.md')}\n`)
    .exitOverride()
    .configureOutput({ writeOut: ctx.stdout, writeErr: writeErrUnlessHandledElsewhere(ctx) })
  registerSync(program, ctx)
  registerReference(program, ctx)
  registerAnalytics(program, ctx)
  registerBudget(program, ctx)
  registerStatus(program, ctx)
  return program
}

export function formatOf(cmd: Command): Format {
  const f = cmd.optsWithGlobals().format
  if (f !== 'json' && f !== 'table') throw new ZmError('INVALID_ARGS', `unknown format: ${f}`, 'use json or table')
  return f
}

// Shared filter options for read commands that operate on transactions/period.
// `--type` and `--search` are tx-specific and added separately by the
// command that needs them.
export function addFilterOptions(cmd: Command): Command {
  return cmd
    .option('--from <date>', 'start date, YYYY-MM-DD (inclusive)')
    .option('--to <date>', 'end date, YYYY-MM-DD (inclusive)')
    .option('--month <month>', 'YYYY-MM, shorthand for --from/--to')
    .option('--category <query>', 'category path, id, or unique leaf title')
    .option('--account <query>', 'account id, or unique title substring')
    .option('--currency <code>', 'filter by primary-side currency')
}

export function readFilters(cmd: Command): Filters {
  const opts = cmd.optsWithGlobals()
  // Checked here, shared by every command that reads filters, so it fails the
  // same way (before the cache is even opened) regardless of which command's
  // own --currency option supplied the empty value.
  if (opts.currency !== undefined && opts.currency.trim() === '') {
    throw new ZmError('INVALID_ARGS', '--currency must not be empty')
  }
  return {
    from: opts.from,
    to: opts.to,
    month: opts.month,
    category: opts.category,
    account: opts.account,
    currency: opts.currency,
    owner: opts.owner,
  }
}

// Shared by withStore and by commands that print outside the JSON envelope
// (e.g. `budget suggest`): a warning when the last sync is more than a day old.
export function staleWarnings(ctx: AppContext, lastSyncAt: string | null): string[] {
  const warnings: string[] = []
  if (lastSyncAt) {
    const hours = (ctx.now().getTime() - new Date(lastSyncAt).getTime()) / (1000 * 60 * 60)
    if (hours > 24) {
      const days = Math.max(1, Math.floor(hours / 24))
      warnings.push(`cache is ${days} ${days === 1 ? 'day' : 'days'} old, run zm sync`)
    }
  }
  return warnings
}

// Shared by withStore and by any command that needs the cache open but skips
// withStore's own {data, meta} envelope (e.g. `budget suggest`, which
// intentionally prints raw yaml instead): opens the cache and refuses an
// empty one the same way as a missing one (a failed `sync` can leave a
// schema-only sqlite file that must not be mistaken for real data).
export function openCheckedStore(ctx: AppContext): Store {
  const store = ctx.openStore()
  if (!store.hasData()) {
    store.close()
    throw new ZmError('NO_CACHE', 'no local cache', 'run zm sync')
  }
  return store
}

// Shared by read commands: opens the cache (openCheckedStore) and prints the
// command's result with a stale-cache warning when the last sync is more
// than a day old.
export function withStore<T>(
  ctx: AppContext,
  cmd: Command,
  fn: (store: Store) => { data: T; meta?: Record<string, unknown>; table?: TableRow[]; warnings?: string[] },
): void {
  const format = formatOf(cmd)
  const store = openCheckedStore(ctx)
  try {
    const { data, meta = {}, table, warnings: fnWarnings = [] } = fn(store)
    const { lastSyncAt } = store.getMeta()
    const warnings = [...fnWarnings, ...staleWarnings(ctx, lastSyncAt)]
    printResult(
      { data, meta: { ...meta, lastSyncAt }, ...(table !== undefined ? { table } : {}), ...(warnings.length ? { warnings } : {}) },
      format,
      ctx.stdout,
    )
  } finally {
    store.close()
  }
}

// The catch block below needs a best-effort output format before the real
// program (which might have failed to even parse `--format`) can be asked for
// one. Only a literal `--format table` or `--format=table` counts — scanning
// for the bare word "table" anywhere in argv would misfire on e.g. `--category
// table`, an unrelated option value that happens to spell the word.
function errorFormat(argv: string[]): Format {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--format' && argv[i + 1] === 'table') return 'table'
    if (arg === '--format=table') return 'table'
  }
  return 'json'
}

// `build` defaults to buildProgram and exists only so tests can exercise run()'s
// exit-code handling against a program with subcommands (e.g. a bare `zm` once
// subcommands exist triggers commander's own help-and-exit-1 behavior) without
// buildProgram itself growing test-only subcommands.
export async function run(
  argv: string[],
  ctx: AppContext,
  build: (ctx: AppContext) => Command = buildProgram,
): Promise<number> {
  try {
    const program = build(ctx)
    await program.parseAsync(argv)
    return 0
  } catch (e) {
    if (
      e instanceof CommanderError &&
      (e.code === 'commander.version' || e.code === 'commander.helpDisplayed' || e.code === 'commander.help')
    ) {
      // exitCode 0 means commander printed help/version on request (e.g. `-h`, `--version`);
      // any other exitCode means commander printed help *because something was wrong*
      // (e.g. a bare invocation with subcommands registered) — that's still a failure.
      return e.exitCode === 0 ? 0 : 2
    }
    return printError(e, errorFormat(argv), ctx.stderr)
  }
}
