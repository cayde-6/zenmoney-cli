# Architecture

`zm` is a read-only CLI over a ZenMoney account: it downloads a diff of the
account into a local SQLite cache, classifies each raw transaction into a
typed model, and runs pure, per-currency analytics and a local budget check
against that model. This document describes the module map, data flow,
classification rules, and the design decisions behind them, as the current
code (`src/`) implements them.

## Module map

```
src/
  bin.ts        entry point: suppresses the node:sqlite experimental warning, calls cli/program
  cli/          commander wiring: global options, command registration, json/table output, exit codes
    commands/   one file per command group: sync (auth+sync), reference (users/accounts/categories/rates/tx),
                analytics (spend/income/compare/recurring), budget (init/status/suggest), status (top-level `zm status`)
  api/          ZenMoney API client (POST /v8/diff) and the raw entity types it returns
  store/        SQLite cache: schema, diff application, meta (serverTimestamp, lastSyncAt)
  query/        query/model.ts classifies raw transactions into typed Tx and builds the Dataset;
                query/filters.ts resolves and applies period/category/account/owner/currency/search filters
  analytics/    pure functions over Tx[]: spend/income grouping, period comparison, recurring detection
  budget/       files.ts does the module's only fs I/O (reads/validates yaml budget files); status.ts (plan vs
                actual, reusing analytics/spend.ts's spendBy for its `unplanned` block) and suggest.ts (draft
                from history) are pure functions over already-loaded data, like analytics/
  auth/         token resolution and storage (env, macOS Keychain, config.json)
  errors.ts     ZmError and the error-code -> exit-code table
  paths.ts      XDG-aware config/cache paths
  util.ts       date/month arithmetic, rounding, fuzzy-match suggestions
```

Dependencies are one-directional: `cli → budget → analytics → query → store`
(`budget/status.ts` reuses `analytics/spend.ts`'s `spendBy` for its
`unplanned` block; `cli` also depends on `analytics` and `query` directly for
commands that don't go through `budget`). `api` is only reached from
`cli/commands/sync.ts` (`zm auth`, `zm sync`). `query` and `analytics` are
pure/synchronous and tested against an in-memory SQLite store, with no
network involved; `budget` is pure/synchronous too except `files.ts`, which
does real fs I/O (reading/writing yaml budget files).

## Data flow

1. **Sync** (`zm sync`): `api/client.ts` POSTs to ZenMoney's diff endpoint
   with the last known `serverTimestamp` (or `0` for `--full`) and gets back
   a `ZmDiff` — arrays of changed `instrument`/`user`/`account`/`tag`/
   `merchant`/`transaction` rows plus a `deletion` array. `store/store.ts`
   applies it in one transaction: upsert every changed row (keyed by id),
   delete every row named in `deletion`, and record the new
   `serverTimestamp`/`lastSyncAt`. `--full` resets all tables first, inside
   the same transaction, so a successful sync never leaves the store empty.
2. **Storage**: each entity table has an `id` primary key, a `raw` column
   holding the entity as JSON exactly as ZenMoney sent it, and (for
   `transaction`) a `date` column used for an index. Nothing is normalized
   into columns beyond what a query needs to index or join.
3. **Loading** (`query/model.ts: loadDataset`): every read command opens the
   store and calls `loadDataset`, which reads all tables, classifies every
   non-deleted, non-zero transaction into a `Tx` (see below), and returns a
   `Dataset` (`users`, `accounts`, `tags`, `instruments`, `txs`). This is the
   one place raw ZenMoney shapes are translated into the CLI's own model.
4. **Filtering** (`query/filters.ts`): commands narrow the `Dataset`'s `txs`
   by period, category (including subcategories), account, owner, currency,
   free-text search, and transaction type.
5. **Analytics / budget**: `analytics/*.ts` and `budget/*.ts` are pure
   functions over the already-classified, already-filtered `Tx[]` — they
   never touch the store or the network, which is what makes them testable
   without any I/O.
6. **Output** (`cli/output.ts`): every read command's result is wrapped in
   `{ data, meta, warnings? }` and printed as JSON, or flattened into a
   table for `--format table`.

## Transaction classification

`loadDataset` skips deleted transactions and transactions that move no money
(`income === 0 && outcome === 0`). Every other transaction is classified by
`query/model.ts: classify()`:

| Type | Condition | Primary side |
|---|---|---|
| `debt` | either `incomeAccount` or `outcomeAccount` is a `debt`-type account | the non-debt account |
| `transfer` | `income > 0 && outcome > 0` and the two accounts differ, and neither is `debt` | the outcome account |
| `expense` | `outcome > 0` (and not already `debt`/`transfer`) | the outcome account |
| `refund` | `income > 0`, and the transaction's first tag has `showOutcome && !showIncome` | the income account |
| `income` | `income > 0`, otherwise | the income account |

The primary side determines the `Tx`'s reported `amount`, `currency`,
`accountId`/`accountTitle`, and `ownerId`. A `transfer` or `debt` also
carries a `counterpart` object for the other side. Category is the first id
in the transaction's `tag` array (or `null` for "Uncategorized"); a
category's full path is built by walking `tag.parent` links to the root.
"Spend" (used by `spend`, `compare`, and the budget commands) is defined as
`expense` transactions counting positively and `refund` transactions
counting negatively (`query/model.ts: isSpendTx`/`spendSign`) — `income`,
`transfer`, and `debt` are never spend.

`ZmTransaction` also models a few raw ZenMoney fields this CLI doesn't
otherwise interpret: `hold` and `originalPayee` are surfaced on `Tx` (and
thus on `zm tx`) — `hold` is ZenMoney's own marker for a not-yet-settled/
pending transaction, and `originalPayee` is the payee text ZenMoney recorded
before any user edit/merchant resolution. Neither affects classification or
aggregation; a `hold` transaction is classified and counted exactly like a
normal, settled one. `opIncome`/`opOutcome`/`opIncomeInstrument`/
`opOutcomeInstrument` are typed-only: kept on `ZmTransaction` so they're
preserved in the cache's raw json (and round-trip if the cache is ever
inspected directly), but are **not** surfaced on `Tx` or in `zm tx` output.

## Owner semantics

`ownerId` on a `Tx` is the `user` field of the **account on the primary
side** — not the transaction's own `user` field. A shared account can carry
operations recorded by either family member; attributing owner to the
account (not the raw transaction owner) is what makes `--owner me` mean "my
accounts' activity." `zm users` lists the account's users; `me` resolves to
the user with no `parent` (ZenMoney's main/family-owner user — the main user
of the family account, not necessarily whoever's API token this CLI is
using), `all` (the default) applies no owner filter, and any other value is
matched against a numeric id or a login.

## Caching and stale warning

Every read command (`withStore` in `cli/program.ts`) opens the cache,
rejects an empty or missing one with a `NO_CACHE` error, and after running,
checks `lastSyncAt`: if the last sync is more than 24 hours old, a top-level
`warnings` array entry (`"cache is 1 day old, run zm sync"`, or `"cache is N
days old, ..."` for N > 1) is added to the JSON envelope (or printed as
`warning: ...` lines for `--format table` and for `zm budget suggest`, which
has no envelope). This is a warning, not an error — stale data is still
returned, so an agent can decide whether to sync first.

`zm status` (`cli/commands/status.ts`) is the one command with none of the
above constraints: it never opens a network connection, never requires a
token, and never touches `Store` at all — it never intentionally mutates
the cache, but "read-only" for a WAL-mode SQLite database is nuanced enough
that this needs stating precisely rather than as a blanket "never creates
files". It tries two approaches, in order:

1. A URI filename (`file:<path>?mode=ro&immutable=1`, still passing
   `{ readOnly: true }`) reads the database without creating any `-wal`/
   `-shm` sidecar file at all — a plain read-only `DatabaseSync` on a
   WAL-mode database still needs to create `-shm` (the shared-memory WAL
   index) just to read consistently, even though it never writes to the
   database itself; `immutable` skips that machinery entirely, which also
   means a directory that isn't writable (so a normal connection couldn't
   create `-shm` there, failing with `SQLITE_READONLY_CANTINIT`) is no
   obstacle. The cost: an immutable connection never looks at `-wal`, so any
   not-yet-checkpointed data in it is invisible. Only attempted when `-wal`
   doesn't exist at all — a cleanly-closed cache never has one, so this
   covers the common case; existence, not merely a non-empty file, is what
   gates it, since a connection actively writing under
   `PRAGMA locking_mode=EXCLUSIVE` can leave `-wal` at 0 bytes for the
   whole span of a transaction.
2. Otherwise (a `-wal` file exists, or the URI approach itself didn't pan
   out), a plain read-only open — this sees WAL data correctly and
   participates in normal SQLite locking (a `PRAGMA busy_timeout` is set so
   a transient lock, e.g. a concurrent `zm sync` mid-write, is waited out
   rather than immediately reported as unreadable), but can need to create
   `-wal`/`-shm` as a side effect of opening. Unlike an earlier version of
   this code, any such sidecar file is deliberately left in place afterwards
   rather than deleted: another process (e.g. a concurrent `zm sync`) could
   start relying on that same sidecar the instant this connection closes,
   and deleting it out from under that process risks corrupting its view of
   the database. So `zm status`, in this rare fallback case, may leave
   `-wal`/`-shm` sidecar files behind next to the cache — it never modifies
   the database's own contents either way.

Either way, a missing/corrupted/permission-denied file is reported via
`{ path, exists, readable, lastSyncAt, ageHours, error? }` rather than
thrown: `exists: false` when the file is missing (nothing more to open),
`readable: false` with an `error` message when it exists but can't be
opened/queried — these cases are indistinguishable from each other by
design, since `zm status` is a diagnostic snapshot, not a repair tool. Its
`token.source` reuses `auth/token.ts`'s resolution order (env, then
Keychain, then `config.json`) but reports only which one matched, via a
`tokenSource` export shared with `resolveToken` — the token's actual value
is never read for display.

`Store.open` (`store/store.ts`) creates the cache dir at mode `0700`, opens
the database with `PRAGMA journal_mode=WAL` and an injectable
`busy_timeout` (default 5000ms, `Store.open(file, { busyTimeoutMs })`), then
chmods the db file (and any `-wal`/`-shm` sidecar files WAL leaves behind)
to `0600` — skipped silently on win32, which has no POSIX permission bits.
Every `Store` method that touches the database (`open`, `migrate`,
`applyDiff`, `reset`, `getMeta`, `all`) funnels a thrown sqlite error
through one classifier comparing `errcode & 0xff` (the primary result code;
the low byte, since an "extended" code like `SQLITE_BUSY_RECOVERY` still
counts as a plain busy):

- `SQLITE_BUSY`/`SQLITE_LOCKED` (5/6) → `CACHE_BUSY` (exit 6) — the cache is
  locked by another connection (e.g. a concurrent `zm sync` writing); the
  caller should just retry. This is not limited to `open`: a lock conflict
  is at least as likely on a write (`applyDiff`/`reset`) as on open.
- `SQLITE_CORRUPT`/`SQLITE_NOTADB` (11/26), or a `JSON.parse` failure on a
  stored row's `raw` column → the existing `NO_CACHE` "cache is unreadable"
  error (hint: `delete <path> and run zm sync --full`). `zm sync --full`
  recovers from this specific case automatically, by deleting the cache
  file (and sidecars) and recreating it before fetching.
- Anything else (`SQLITE_READONLY`, `SQLITE_CANTOPEN`, `SQLITE_FULL`,
  `SQLITE_IOERR`, ...) → `UNEXPECTED`, carrying the underlying sqlite
  message as-is. These are real, distinct failures (a read-only filesystem,
  a missing directory, a full disk, ...) and must never be mistaken for
  corruption — in particular, `sync --full`'s delete-and-recreate recovery
  only ever triggers on `NO_CACHE`, so it never deletes a perfectly good
  cache file just because the disk happened to be full or the directory
  briefly unwritable.

## Token storage flow

`zm auth` accepts a token via `--token`, stdin (piped, non-TTY), or an
interactive hidden prompt (raw-mode TTY reading in
`cli/commands/sync.ts: promptHidden`, built on a unit-tested keystroke state
machine, `applyKeystrokes`). The token is validated by calling the diff
endpoint before it's ever saved — this uses the token just supplied on this
invocation, not a stored one, so `zm auth` never calls `resolveToken`.
`saveToken` (`auth/token.ts`) prefers the macOS Keychain (service
`zenmoney-cli`) when available, falling back to `~/.config/zm/config.json`
elsewhere or on failure — written atomically (a mode-0600 temp file in the
same dir, renamed into place, so there's never a window where the file
exists at a more permissive mode). A stored token is only looked up by
commands that call the ZenMoney API: `zm sync` calls `requireToken`
(`resolveToken`, throwing `AUTH` if nothing is found), checking in order the
`ZENMONEY_TOKEN` env var, then the Keychain, then `config.json`. Every read
command opens the cache directly and never calls `resolveToken` at all.
`ZM_DISABLE_KEYCHAIN=1` disables the Keychain branch entirely — used by
tests, so a real token in a developer's Keychain can never leak into a test
run, and by any sandbox without `security` access.

## Error model and exit codes

Every failure is a `ZmError` (`errors.ts`) carrying a `code`, `message`, and
optional `hint`. Commander validation failures are normalized into the same
shape. `cli/output.ts: printError` prints `{"error": {"code", "message",
"hint"}}` to stderr (or `error: ...` / `hint: ...` plain-text lines for
`--format table`) and the process exits with the code's mapped status:

| Code | Exit | Meaning |
|---|---|---|
| `UNEXPECTED` | 1 | unexpected/internal error |
| `INVALID_ARGS` | 2 | bad flags, invalid/unknown budget yaml, or a missing budget file |
| `AUTH` | 3 | no token, ZenMoney rejected it (401/403), or the token could not be stored |
| `NETWORK` | 4 | network failure or non-2xx ZenMoney response |
| `NO_CACHE` | 5 | no local cache yet (`zm sync` hasn't run), or the cache file/a row is corrupted |
| `CACHE_BUSY` | 6 | cache is locked by another connection (e.g. a concurrent `zm sync`) |

Option-shape validation (e.g. an unknown `--by`, an invalid `--month`) runs
*before* the cache is opened, so a bad invocation fails the same way whether
or not `zm sync` has ever run.

## Budget model

Budget files live in `~/.config/zm/budget/`: an optional `default.yaml`
template and optional per-month `YYYY-MM.yaml` overrides. `budget/files.ts`
parses and validates each file's shape independently (a limit is a plain
number or `{ amount, currency }`; `null` is only meaningful in a month
file, where it deletes the template's limit for that key) and then merges
template + month into one `Map<categoryKey, LimitSpec>`
(`mergeBudget`) — a plain number is priced in the currency declared by the
file it's written in, so a numeric limit in the template keeps the
template's currency even under a month file that declares a different one.

`budget/status.ts: budgetStatus` resolves each limit's key to a category
(erroring if two keys resolve to the same category — see below), sums that
month's spend into it (a transaction under a subcategory that itself has no
limit rolls up into its parent's row; one with its own limit counts only
there), and reports `planned`/`spent`/`remaining`/`usedPct`/`pace` per row,
plus an `unplanned` group for spend under no limited category at all.
`pace` is `usedPct - monthElapsedPct`: positive means spending faster than
the month is progressing.

`budget/suggest.ts: suggestBudget` drafts a `default.yaml`-shaped yaml from
historical spend: for each (category, currency) pair seen over a window of
full months before the target month, it takes the median of monthly net
spend, keeping only pairs that recurred in at least half the sampled
months, and never suggesting a limit `<= 0`.

## Design decisions

- **Read-only.** `zm` never writes to ZenMoney — no operations, no
  categories, no ZenMoney-side budgets. This removes an entire class of
  risk (an agent silently altering a user's real financial data) for a tool
  whose job is to answer questions, not to manage the account.
- **No currency conversion.** Every sum and aggregate is reported per
  currency; the CLI never adds amounts in different currencies. A mixed
  total is a different, error-prone kind of number (it depends on which
  day's rate you use), so it's left to the caller to compute explicitly
  (via `zm rates`) and label as an estimate — never presented as fact by
  this tool.
- **`node:sqlite`, not a native driver.** The cache uses Node's built-in
  SQLite binding instead of `better-sqlite3` or similar, so `npm install`
  never needs to build or download a native addon — important for a CLI
  installed globally across arbitrary machines and CI images.
- **Raw JSON storage.** Each cached entity keeps its original JSON in a
  `raw` column, not just the columns the CLI currently queries. A future
  ZenMoney API field, or a bug in what the CLI extracts today, doesn't lose
  data already synced — `loadDataset` can be fixed and rerun against the
  same cache without a resync.
- **Fetch-before-write, atomic `--full`.** `zm sync` calls the API before
  it touches the cache at all, and (for `--full`) resets tables inside the
  same transaction as the upsert. A failed sync (network error, bad token)
  always leaves the existing cache exactly as it was — there's no window
  where `--full` has wiped the cache but not yet repopulated it.
- **Token via `security -i` on stdin, not argv.** Writing to the macOS
  Keychain shells out to `security`, but the token is sent as a batched
  command on stdin rather than as a command-line argument, because argv is
  visible to any local user via `ps`. The same reasoning is why `zm auth
  --token <token>` is documented as the least-preferred way to supply a
  token.
- **Duplicate limit key is a hard error.** If two budget keys (e.g.
  `Cafe` and `Food/Cafe`, spelled differently but resolving to the same
  category) both appear in the merged limit map — whether both are in the
  same file or one is in the template and the other in a month file —
  `budget status` refuses to guess which one is "current" and errors out
  instead — a silent pick would make one written limit invisible without any
  indication why.
- **Full-month suggest window.** `budget suggest` samples only complete
  calendar months strictly before the target month (and never the current,
  still-in-progress month). Including a partial month would skew the
  median low for no real reason — that month's spend simply hasn't
  finished happening yet.
- **Periodicity from first-seen month.** `recurring` calls a merchant
  "monthly" if it's present in every month from its first occurrence in the
  window up to the month before the current one (not every month in the
  whole window, and not the current, still-in-progress month), and it was
  seen in at least 2 distinct months. A subscription that started partway
  through the window is still "monthly," rather than being penalized for a
  window that starts before it existed; a single occurrence is never
  "monthly," however narrow the window.
- **Owner = the primary side's account, not the raw `user` field.** See
  "Owner semantics" above — this is what makes `--owner` a meaningful
  filter on a shared account rather than an artifact of who happened to
  record the transaction.
