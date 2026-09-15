# Contributing

Thanks for considering a contribution to `zenmoney-cli`.

## Prerequisites

- Node.js 22.20+ or 24.x for development, matching CI (a build-tool optional
  dependency declares that engine range). The published CLI itself runs on
  Node.js >= 22.13, the first 22.x where `node:sqlite` works without a flag.
  `.nvmrc` pins Node 22 for `nvm use`.

## Setup

```
git clone https://github.com/cayde-6/zenmoney-cli.git
cd zenmoney-cli
npm ci
npm run build
```

## Scripts

| Command | Does |
|---|---|
| `npm run build` | bundle `src/` into `dist/` with tsup |
| `npm test` | run the vitest suite once |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | typecheck, then test, then build — run this before opening a PR |

## Project layout

```
src/
  cli/          commander wiring, commands, output formatting
  api/          ZenMoney API client and raw entity types
  store/        SQLite cache
  query/        classification and filters (raw ZenMoney -> Tx -> filtered Tx[])
  analytics/    pure aggregation functions over Tx[]
  budget/       yaml budget files, status, suggest
  auth/         token resolution and storage
tests/          mirrors src/, plus tests/e2e (built binary) and tests/fixtures (synthetic diff)
```

See [`docs/architecture.md`](docs/architecture.md) for how the pieces fit
together and why they're built the way they are.

## Testing conventions

- `tests/fixtures/diff.ts` is a **synthetic** ZenMoney diff — two users
  (`owner`/`partner`), a handful of neutral accounts, categories, and
  transactions. **Never replace it with, or add, real ZenMoney data** to
  this repository, in a fixture, a test assertion, or anywhere else.
- No NUL bytes anywhere under `src/` or `tests/`, including in test fixtures
  and string literals — `tests/repo/no-nul.test.ts` enforces this. (A NUL
  byte in a shell-batched command, like the one `auth/token.ts` sends to
  `security -i`, can silently truncate it.)
- Most unit tests build an `AppContext` via `tests/helpers.ts`'s
  `testContext` (a fake context — in-memory clock, fake fetch, no real
  Keychain — but a real temporary directory and an on-disk SQLite cache) or
  `seededContext` (the same, pre-loaded with `tests/fixtures/diff.ts`).
  `fixtureStore()` is the one in-memory-SQLite helper, used where a test
  doesn't need a full `AppContext`. Prefer these over constructing a context
  or store by hand.
- `tests/e2e/bin.test.ts` runs the actual built `dist/bin.js` with
  `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` pointed at a temporary directory, so it
  depends on `npm run build` having been run first (its `beforeAll` builds
  automatically).

## Code rules

- **Throw `ZmError`, never call commander's `cmd.error()`.** All error
  handling flows through `run()`'s catch block in `cli/program.ts`, which
  turns any `ZmError` into the JSON/table `{"error": {...}}` envelope and
  the matching exit code (see `errors.ts`). A raw `cmd.error()` bypasses
  that and produces inconsistent output.
- **Never add amounts across currencies.** Every aggregate is per-currency,
  on purpose — see `docs/architecture.md`'s "No currency conversion"
  design decision. If a change looks like it needs to sum two different
  currencies into one number, it's very likely wrong.
- **Validate option shape before opening the cache.** A command should
  reject a bad flag (unknown `--by`, invalid `--month`, etc.) before
  calling `withStore`/`ctx.openStore()`, so invalid arguments fail the same
  way regardless of whether a local cache exists yet.
- **Every read command's result is a `{ data, meta, warnings? }` envelope**
  (built by `withStore` in `cli/program.ts`), except `zm budget suggest`,
  which prints raw yaml to stdout by design (see `SKILL.md`).

## Adding a command

1. Register it in the relevant `src/cli/commands/*.ts` file (or add a new
   file and call its `register*` function from `cli/program.ts`), following
   the pattern of an existing command in the same file.
2. If it reads the cache, use `withStore` (see `cli/program.ts`) rather than
   opening the store directly, so it gets the standard `NO_CACHE` handling,
   stale-cache warning, and envelope for free.
3. Add unit tests for any new pure logic, plus a `tests/cli/*.test.ts` test
   for the command's wiring (flag validation, envelope shape, exit codes).
4. Add an `--help` example via `.addHelpText('after', ...)` on the command.
5. Update `README.md`'s command reference and `SKILL.md`'s command
   reference table — both are meant to stay in sync with `--help`.

## Commit style

This repository uses [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `chore:`, `test:`, etc.), optionally scoped, e.g.
`fix(budget): reject unknown top-level yaml keys`.

## Privacy reminder

This is a public repository. Never commit real ZenMoney data, real personal
information, or anything that could identify an individual account —
fixtures and examples must stay synthetic and neutral (see
`tests/fixtures/diff.ts` for the shape to follow).
