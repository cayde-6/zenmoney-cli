# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Transaction writes**: `zm edit <ids...>`, `zm add`, and `zm delete
  <ids...>` — the only commands that write to ZenMoney, and only
  transactions. Every one is a dry-run by default: it prints `{ applied,
  token, applyCommand, changes, balanceImpact }`, and writing requires
  rerunning the exact printed `applyCommand` (`--apply --expect <token>`).
  `--apply` re-syncs and recomputes the plan first; a change already in
  its target state is dropped (so retrying a landed write after a network
  error is safe), and a token that no longer matches the recomputed plan
  is a new exit code, `CONFLICT` (7) — rerun the dry-run to see the
  current state. `zm edit` can change `--comment`/`--payee`/`--category`/
  `--date` on any transaction, and `--amount`/`--account` on a
  single-currency simple one (a transfer, a debt, or a foreign-currency
  transaction rejects the latter two, exit 2, no partial edit). `zm add`
  creates a new single-currency simple transaction. `zm delete` marks a
  transaction deleted, the same as deleting it in the app; its dry-run
  shows the full raw copy of what would be deleted. `--owner` other than
  `all` is rejected by all three.
- Exit code 7 (`CONFLICT`), used by the three write commands above.

### Changed

- `zm` is no longer strictly read-only: `zm edit`/`zm add`/`zm delete
  --apply` write transactions to ZenMoney (see "Added" above). Every other
  command is unaffected and stays read-only.

## [0.1.1] - 2026-09-17

### Changed

- `zm rates`: when the main user's currency instrument is missing from the
  local cache, this now reports `NO_CACHE` (exit 5, hint `run zm sync
  --full`) instead of `UNEXPECTED` (exit 1, no hint) — matching how `zm
  budget init`/`zm budget suggest` already treat the same stale-cache
  condition.

## [0.1.0] - 2026-09-15

Initial release of `@cayde-6/zenmoney-cli`.

### Added

- **Auth & sync**: `zm auth` (token via prompt, stdin, `--token`, or
  `ZENMONEY_TOKEN`; macOS Keychain or `config.json` storage; `--logout`),
  `zm sync` (incremental and `--full`).
- **Reference data**: `zm users`, `zm accounts` (`--archived`),
  `zm owners` (`--archived`), `zm categories` (`--tree`), `zm rates`.
- **Transactions**: `zm tx` with period (`--from`/`--to`/`--month`),
  category (parent includes subcategories), account, currency, owner,
  `--type`, `--search`, and `--limit` filters.
- **Owners config**: an optional `<configDir>/owners.yaml` maps owner
  names (must start with a letter, `[A-Za-z][A-Za-z0-9._-]*`, a genuine
  yaml string key, and can't equal another name case-insensitively) to
  accounts, by id or by title, for families whose ZenMoney data has no
  per-account ownership (every account/transaction/tag/merchant carrying
  the same `user`). A title entry with a letter/digit not part of a
  keycap emoji sequence is a case-insensitive substring match; a bare
  emoji/symbol entry (keycaps included) instead has to align to a whole
  Unicode grapheme cluster in the title (so a bare emoji never matches a
  fragment of a larger ZWJ/skin-tone/keycap sequence), normalizing NFC and
  stripping variation selectors first — `Intl.Segmenter`, needed only for
  this, is constructed on first actual use, so a Node build without full
  ICU support still works for any file with no emoji/symbol entries. An
  exact account-id entry wins over another owner's title match; a genuine
  conflict is a hard error naming the account and every matching owner
  (hint: pin it by account id, run `zm owners` to see all conflicts) —
  except on an archived account, where it's a warning (account treated as
  unassigned) instead of failing the command, and except in `zm owners`
  itself, which never fails on a conflict (it's the diagnostic tool that
  hint points to): a non-archived conflict there is reported via
  `data.conflicts: [{ id, title, owners }]` and a warning, exit 0. Once
  the file exists, `--owner` switches from ZenMoney-user semantics
  (`me|<id>|<login>`) to `all`|`unassigned`|a file owner name (matched
  case-insensitively, resolving to the file's own spelling) everywhere
  except `zm users`, which rejects any non-`all` value outright once the
  file is active (no natural mapping onto file owner names) with a hint
  pointing to `zm owners` — and reads the file at all only when `--owner`
  isn't `all`, so a broken file can't break the default invocation; an
  unknown name's hint lists every defined name plus the file's path.
  `tx`/`spend`/`income`/`compare`/`recurring`/`budget status` gain an
  `owner` field/meta echoing the file's resolved spelling (`--owner ALEX`
  reports `"alex"`), and `tx` also gains an `owner` field on each row
  alongside the existing `ownerId`; `zm accounts`' `owner` field reports
  the file's owner name instead of the ZenMoney login; and the new
  `zm owners` command (no network) reports the file's own
  `{ name, accounts }` mapping, which accounts are unassigned, and which
  are in conflict, `--format table` as `{ owner, id, title }` rows, and
  warns about a non-archived conflict, an entry matching zero accounts
  (any entry), or a *short* text entry (at most 2 letters/digits) matching
  more than half of all accounts — a longer text entry or any emoji/symbol
  entry is never flagged for over-matching, since a shared emoji-prefix
  naming convention across most accounts is common and legitimate, not a
  mistake. `zm status` reports `ownersFile: { path, exists, valid,
  error? }`, parsed independently of the cache (`valid` covers parsing
  only — a matching conflict needs the cache, so it only shows up via
  `zm owners`). A directory or otherwise unreadable owners.yaml is a clear
  `INVALID_ARGS` naming the path. With no `owners.yaml`, every command
  behaves exactly as before.
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
  the real cache file or its directory, on any supported Node version: it
  copies the cache (and its `-wal` file, if present) into a private temp
  directory and opens that copy normally rather than read-only, so any data
  committed but not yet checkpointed is included. A copy torn by a
  concurrent write landing mid-copy is detected (comparing the cache's
  size/`-wal` header before and after copying it, and via an integrity
  check on the copy) and retried with a fresh copy a few times before
  giving up with `readable: false` and a "retry shortly" message; the temp
  directory is always removed again afterwards.

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

- `spend --by merchant`'s `(no merchant)` bucket is now keyed internally
  by a dedicated `Symbol`, not the string `'(no merchant)'` itself — a
  real transaction whose resolved merchant/payee/originalPayee/comment
  label happened to literally be that text would otherwise normalize to
  the same string key and silently merge into the true no-merchant group,
  understating one and overstating the other. The displayed group `key`
  is unaffected either way.
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
- On macOS, `zm auth` actually delivers the token to `security -i` on
  stdin: `execFileSync` was called with stdio's first slot set to
  `'ignore'`, which makes Node silently drop the `input` string instead of
  writing it to the child process, so the Keychain write always failed
  (invisibly) and every token was written to `config.json` instead. Also,
  when a Keychain **is** available but the write to it fails, `zm auth`
  now adds a `warnings` entry saying so, instead of silently falling back
  to `config.json` with no indication anything went wrong.
- `zm recurring` finds recurring payments on real ZenMoney data where an
  expense has no resolved merchant and no payee at all — common for
  subscriptions like Netflix or iCloud, where the only text is the
  free-form `comment`. Both `zm recurring` and `zm spend --by merchant`
  fall back through `merchant` -> `payee` -> `originalPayee` -> `comment`
  (previously `recurring` only ever looked at the `merchant` field, and
  that field itself silently folded in `payee` whenever there was no real
  merchant match — so a payee-only transaction was misreported as a
  merchant hit, and `originalPayee`/`comment` were never reached at all).
  `Tx.merchant` is now the resolved merchant title only (`null` when
  ZenMoney found no match); `Tx.payee` is unaffected and stays independently
  readable. `recurring`'s output gains a `source` field naming which of the
  four fields the label actually came from. `recurring` and `spend --by
  merchant` also now share one grouping key — lowercased, with internal
  whitespace collapsed, not just trimmed — instead of `spend --by merchant`
  grouping by the raw label as it did before: `"Netflix"` and `"netflix "`
  now land in one group in both commands, displayed using the spelling
  from the group's most recent transaction.

### Changed

- The label for transactions with no category (`categoryPath` when a
  transaction's tag doesn't resolve) is `Uncategorized` (not a Russian
  string), exported as `NO_CATEGORY` and used everywhere instead of a
  duplicated literal.
- `zm spend --by merchant`'s fallback group key for a transaction with no
  merchant is `(no merchant)` (not a Russian string) — since `--by merchant`
  now also falls back to payee/originalPayee/comment, this bucket only
  appears when all four of those fields are empty.
- All sorting of names/paths/keys (categories, accounts, currencies,
  merchants, ...) uses one shared `Intl.Collator('en')`-based comparator,
  so ordering is deterministic regardless of the process's `LANG`. Cyrillic
  category titles from real ZenMoney data are still handled correctly at
  runtime.

[Unreleased]: https://github.com/cayde-6/zenmoney-cli/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/cayde-6/zenmoney-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cayde-6/zenmoney-cli/releases/tag/v0.1.0
