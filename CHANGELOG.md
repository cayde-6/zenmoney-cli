# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-15

Initial release of `@cayde-6/zenmoney-cli`.

### Added

- **Auth & sync**: `zm auth` (token via prompt, stdin, `--token`, or
  `ZENMONEY_TOKEN`; macOS Keychain or `config.json` storage; `--logout`),
  `zm sync` (incremental and `--full`).
- **Reference data**: `zm users`, `zm accounts` (`--archived`),
  `zm categories` (`--tree`), `zm rates`.
- **Transactions**: `zm tx` with period (`--from`/`--to`/`--month`),
  category (parent includes subcategories), account, currency, owner,
  `--type`, `--search`, and `--limit` filters.
- **Analytics**: `zm spend` (by category/month/merchant, with `--tree`),
  `zm income` (by category/month), `zm compare` (two periods, by total or
  category), `zm recurring` (subscription/recurring-payment detection).
- **Budget**: `zm budget init` (template from real categories),
  `zm budget status` (plan vs actual, pace, unplanned spend),
  `zm budget suggest` (draft from historical medians).
- **Output**: `--format json|table` on every command; a `{ data, meta,
  warnings? }` JSON envelope; stable exit codes (0 success, 1 unexpected
  error, 2 invalid arguments, 3 auth, 4 network, 5 no local cache, 6 cache
  busy).
- **For agents**: `SKILL.md`, linked from `zm --help`, documenting the
  command reference, currency-safety rule, and common recipes.
- File permissions: the config, cache, and budget directories are created
  at mode `0700`, and the cache database (plus any WAL/SHM sidecar files)
  is chmodded to `0600` after every open. Skipped silently on win32.
- `Store.open` sets `PRAGMA journal_mode=WAL` and an injectable
  `busy_timeout` (default 5000ms). A lock conflict on any cache operation
  (not just opening — a write like `applyDiff` is at least as likely to hit
  one) fails fast with a `CACHE_BUSY` error (exit code 6, `cache is busy
  (another zm sync is running)`) instead of hanging, looking like a missing
  cache, or crashing with an unhandled sqlite error.
- A corrupted local cache (an unreadable db file, or a row that isn't
  valid JSON) fails with a clear `NO_CACHE` hint (`delete <path> and run
  zm sync --full`) instead of an unhandled exception; `zm sync --full`
  recovers from this automatically by deleting and recreating the cache.
  A distinct sqlite failure that isn't actually corruption (e.g. a
  read-only filesystem or a missing directory) surfaces as its own
  `UNEXPECTED` error instead, and never triggers that delete-and-recreate
  recovery.
- `config.json` is written atomically (a mode-0600 temp file renamed into
  place), removing a brief window where it could exist at a more
  permissive mode.
- `zm auth --logout` warns when `ZENMONEY_TOKEN` is still set in the
  environment, since it takes precedence over the removed stored token
  and will still be used.
- Network requests (`zm auth`, `zm sync`) time out after a configurable
  `ZM_TIMEOUT_MS` milliseconds (default 60000, must be a positive integer)
  instead of a hardcoded 60s.
- A network-level fetch failure's message includes the underlying
  `cause.code` (e.g. `ENOTFOUND`, `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`)
  when present, still with the token scrubbed.
- `zm budget suggest` falls back to the main user's currency when no
  (category, currency) pair qualifies for the draft, instead of an empty
  `currency:` that wouldn't round-trip through `zm budget status`.
- `zm budget status`: a limit key that no longer resolves to any category
  (e.g. renamed or deleted in ZenMoney) is skipped with a `warnings`
  entry instead of failing the whole command, and listed under
  `data.unresolved: [{ key, amount, currency }]`. Two keys that still
  resolve to the same category remain a hard error.
- `zm status` command: reports cache path/existence/`readable`/`error`/
  `lastSyncAt`/`ageHours`, where a token would be found
  (`env`/`keychain`/`config`/`null`, never the token itself), `configDir`,
  `budgetDir`, and the installed version. Makes no network call, works
  without a token or a cache, and reads the cache without ever writing to
  the real cache file or its directory: it copies the cache (and its `-wal`
  file, if present) into a private temp directory, reads that copy —
  including any data committed but not yet checkpointed — and removes the
  temp directory again afterwards.

### Documentation

- Clarified everywhere `--owner me` is documented (`--help`, README,
  SKILL.md, architecture.md) that it means the main user of the family
  account (the ZenMoney user with no parent) — not necessarily whoever's
  API token the CLI is using.
- SKILL.md documents that `tx.amount` is always positive (its meaning
  depends on `tx.type`), that `spend = expenses - refunds`, that a
  `spend`/`income` group's `count` includes refunds, and how to reproduce
  a `spend` figure from raw `tx` rows. It also recommends `ZENMONEY_TOKEN`
  or piping the token over `zm auth --token`, which is visible in shell
  history and the process list.

### Fixed

- A relative `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` is ignored (falls back to
  the default), per the XDG Base Directory spec, instead of being joined
  as-is into a path relative to the process's working directory.
- A transaction whose tag id doesn't resolve to any known tag (deleted or
  never synced) gets `categoryId: null`/`topCategoryId: null` like a
  transaction with no tag at all, instead of leaking the unresolvable id
  through as `categoryId`.
- `--category` resolves a category whose own title contains `/` (e.g. a
  tag titled `Phone/Internet`) both by its full path and by its bare leaf
  title — the leaf-title match used to split the joined path on `/`,
  which extracted the wrong, partial text for a title containing one.
- The stale-cache warning uses correct singular/plural grammar
  (`"cache is 1 day old, ..."` vs `"cache is N days old, ..."`).
- `zm tx` includes `hold` (boolean) and `originalPayee` (string|null)
  fields, taken from the raw ZenMoney transaction — `hold` is ZenMoney's
  marker for a not-yet-settled/pending transaction and never affects
  classification or aggregation (a hold transaction is counted exactly
  like a normal one). The internal `ZmTransaction` type also models
  `opIncome`/`opOutcome`/`opIncomeInstrument`/`opOutcomeInstrument`, but
  those are typed-only (preserved in the cache's raw json) and are **not**
  surfaced on `Tx` or in `zm tx` output.

### Changed

- The label for transactions with no category (`categoryPath` when a
  transaction's tag doesn't resolve) is `Uncategorized` (not a Russian
  string), exported as `NO_CATEGORY` and used everywhere instead of a
  duplicated literal.
- `zm spend --by merchant`'s fallback group key for a transaction with no
  merchant is `(no merchant)` (not a Russian string).
- All sorting of names/paths/keys (categories, accounts, currencies,
  merchants, ...) uses one shared `Intl.Collator('en')`-based comparator,
  so ordering is deterministic regardless of the process's `LANG`. Cyrillic
  category titles from real ZenMoney data are still handled correctly at
  runtime.

[Unreleased]: https://github.com/cayde-6/zenmoney-cli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/cayde-6/zenmoney-cli/releases/tag/v0.1.0
