# CLAUDE.md

Guide for coding agents working **on** this repository (`zenmoney-cli`
itself — its source, tests, and docs). For guidance on **using** the built
`zm` CLI to answer questions about someone's ZenMoney data, see
[`SKILL.md`](SKILL.md) instead.

## Commands

| Command | Does |
|---|---|
| `npm run build` | bundle `src/` into `dist/` with tsup |
| `npm test` | run the vitest suite once |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | typecheck, then test, then build — run this before considering a change done |

Running the CLI needs Node.js >= 22.13 (`node:sqlite` without a flag).
Development uses Node.js 22.20+ or 24.x, same as CI (a build-tool
optional dependency declares that engine range).

## Layout

```
src/
  cli/          commander wiring, commands, output formatting
  api/          ZenMoney API client and raw entity types
  store/        SQLite cache
  query/        classification (raw ZenMoney -> Tx) and filters
  analytics/    pure aggregation functions over Tx[]
  budget/       yaml budget files, status, suggest
  auth/         token resolution and storage
tests/          mirrors src/, plus tests/e2e (built binary) and tests/fixtures (synthetic diff)
```

Full design: [`docs/architecture.md`](docs/architecture.md).

## Code rules

- Throw `ZmError` (see `src/errors.ts`) for anything that should surface as
  a command failure; never call commander's `cmd.error()` directly.
- Never add amounts across currencies — every aggregate stays per-currency.
- Validate option shape (flags, period, etc.) before opening the cache, so
  a bad invocation fails the same way with or without a synced cache.
- Every read command's result is a `{ data, meta, warnings? }` envelope via
  `withStore` (`src/cli/program.ts`), except `zm budget suggest`, which
  intentionally prints raw yaml with no envelope.

## Testing conventions

- `tests/fixtures/diff.ts` is a synthetic ZenMoney diff. Never add or
  substitute real ZenMoney data anywhere in this repository.
- No NUL bytes in `src/` or `tests/` (`tests/repo/no-nul.test.ts` checks
  this) — never type or generate a literal NUL byte anywhere.
- Use `tests/helpers.ts`'s `testContext`/`seededContext` to build an
  `AppContext` for unit tests instead of constructing one by hand.

## Docs to update when behaviour changes

Flags, output shapes, exit codes, or budget-file semantics changing means
updating, as applicable:

- `README.md` (command reference, quick start examples, budget file docs)
- `SKILL.md` (command reference table, recipes)
- `docs/architecture.md` (data flow, classification, design decisions)
- `CHANGELOG.md` (add an entry under `[Unreleased]`)

`README.md` and `SKILL.md` are meant to always match the real `--help`
output — verify with `npm run build && node dist/bin.js <command> --help`
before editing either.

## Never

- Run `zm auth` or `zm sync` against the real ZenMoney API from an agent
  session — both make live network calls.
- Commit real financial data, real names, emails, or other personal
  identifiers — this repository is public.
