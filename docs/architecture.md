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
                analytics (spend/income/compare/recurring), budget (init/status/suggest)
  api/          ZenMoney API client (POST /v8/diff) and the raw entity types it returns
  store/        SQLite cache: schema, diff application, meta (serverTimestamp, lastSyncAt)
  query/        query/model.ts classifies raw transactions into typed Tx and builds the Dataset;
                query/filters.ts resolves and applies period/category/account/owner/currency/search filters
  analytics/    pure functions over Tx[]: spend/income grouping, period comparison, recurring detection
  budget/       yaml budget files (load/merge/validate), status (plan vs actual), suggest (draft from history)
  auth/         token resolution and storage (env, macOS Keychain, config.json)
  errors.ts     ZmError and the error-code -> exit-code table
  paths.ts      XDG-aware config/cache paths
  util.ts       date/month arithmetic, rounding, fuzzy-match suggestions
```

Dependencies are one-directional: `cli → analytics | budget → query → store`.
`api` is only reached from `cli/commands/sync.ts` (`zm auth`, `zm sync`).
`query`, `analytics`, and `budget` are pure/synchronous and tested against an
in-memory SQLite store, with no network involved.

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
in the transaction's `tag` array (or `null` for "Без категории"); a
category's full path is built by walking `tag.parent` links to the root.
"Spend" (used by `spend`, `compare`, and the budget commands) is defined as
`expense` transactions counting positively and `refund` transactions
counting negatively (`query/model.ts: isSpendTx`/`spendSign`) — `income`,
`transfer`, and `debt` are never spend.

## Owner semantics

`ownerId` on a `Tx` is the `user` field of the **account on the primary
side** — not the transaction's own `user` field. A shared account can carry
operations recorded by either family member; attributing owner to the
account (not the raw transaction owner) is what makes `--owner me` mean "my
accounts' activity." `zm users` lists the account's users; `me` resolves to
the user with no `parent` (ZenMoney's main/family-owner user), `all` (the
default) applies no owner filter, and any other value is matched against a
numeric id or a login.

## Caching and stale warning

Every read command (`withStore` in `cli/program.ts`) opens the cache,
rejects an empty or missing one with a `NO_CACHE` error, and after running,
checks `lastSyncAt`: if the last sync is more than 24 hours old, a top-level
`warnings` array entry (`"cache is N days old, run zm sync"`) is added to
the JSON envelope (or printed as `warning: ...` lines for `--format table`
and for `zm budget suggest`, which has no envelope). This is a warning, not
an error — stale data is still returned, so an agent can decide whether to
sync first.

## Token storage flow

`zm auth` accepts a token via `--token`, stdin (piped, non-TTY), or an
interactive hidden prompt (raw-mode TTY reading in
`cli/commands/sync.ts: promptHidden`, built on a unit-tested keystroke state
machine, `applyKeystrokes`). The token is validated by calling the diff
endpoint before it's ever saved — this uses the token just supplied on this
invocation, not a stored one, so `zm auth` never calls `resolveToken`.
`saveToken` (`auth/token.ts`) prefers the macOS Keychain (service
`zenmoney-cli`) when available, falling back to `~/.config/zm/config.json`
(mode 0600) elsewhere or on failure. A stored token is only looked up by
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
| `NO_CACHE` | 5 | no local cache yet (`zm sync` hasn't run) |

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
  `Кафе` and `Еда/Кафе`, spelled differently but resolving to the same
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
