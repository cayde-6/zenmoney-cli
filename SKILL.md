---
name: zenmoney-cli
description: "Read a user's ZenMoney spending via the zm CLI: transactions, per-currency aggregates, recurring payments, and a local monthly budget. Use when asked to analyse spending, find subscriptions, or plan a budget."
---

# zenmoney-cli

`zm` is a read-only CLI over a user's ZenMoney data. It never writes to
ZenMoney — only to a local SQLite cache and local budget yaml files.

## Setup

```
npm i -g @cayde-6/zenmoney-cli   # once published — see README.md for install-from-source
zm auth
zm sync
```

`zm auth` stores a ZenMoney API access token (macOS Keychain, or
`~/.config/zm/config.json` elsewhere). `zm sync` downloads the account into a
local cache; run it again any time to pick up new transactions.

Prefer setting the `ZENMONEY_TOKEN` environment variable, or piping the token
into `zm auth` (`echo "$TOKEN" | zm auth`), over `zm auth --token <token>`:
a `--token` value ends up in shell history and is visible to other processes
via the process list (`ps`). Only use `--token` in a context where neither of
those is available.

## Rules for agents

- Every command prints a `{ data, meta, warnings? }` JSON envelope, **except
  `zm budget suggest`**, which prints a raw yaml draft to stdout (no
  envelope) and puts warnings on stderr as plain `warning: ...` lines instead.
- `meta.lastSyncAt` is present on every command that opens the local cache
  (all read commands, plus `zm sync` itself); `zm auth` and `zm status` have
  no `meta.lastSyncAt` (`zm status` reports the same information as
  `data.cache.lastSyncAt` instead, since it works even without a cache).
  When the cache is stale, cache-reading commands also add a top-level
  `warnings` array with an entry like `"cache is 1 day old, run zm sync"` (or
  `"N days old"`). If you see that warning, run `zm sync` before reporting
  numbers.
- `zm status` makes no network call and needs neither a token nor a cache —
  run it first when something else isn't working.
- **Before using `--owner` to split spend by family member, run `zm
  owners` first** (reads the cache and the optional
  `~/.config/zm/owners.yaml`, no network). If `data.file` is non-null,
  `--owner` takes `all` (default), `unassigned`, or one of `data.owners[].name`
  (matched case-insensitively) — not a ZenMoney login or id, and not on
  `zm users` (see below). If `data.file` is `null` (no `owners.yaml`),
  `--owner` instead takes ZenMoney-user semantics: `me` (the main user of
  the family account, i.e. the user with no parent — not necessarily
  whoever's API token this CLI is using), `all`, a numeric user id, or a
  login (see `zm users`). Don't guess which mode applies — `zm owners`
  tells you directly, and an unrecognized `--owner` value exits 2 with a
  hint listing every defined owner name (not a fuzzy guess) once
  `owners.yaml` exists.
- If `zm owners`' `data.owners[].accounts[].title` contains an emoji, and
  you need to write an `owners.yaml` entry that matches it, **copy the
  emoji exactly from that title** rather than retyping it — a bare emoji
  only matches a title's whole grapheme cluster (e.g. a skin-toned emoji or
  a ZWJ family sequence), never a fragment of one. `zm owners`' `warnings`
  flag an entry that ends up matching zero accounts, so a mistyped one
  is never silently a no-op.
- A `zm owners` (or any owner-filtered command's) conflict — two owners'
  entries both matching the same account — exits 2 (`INVALID_ARGS`) unless
  the account is archived, in which case it's a `warnings` entry and the
  account is treated as unassigned instead of failing the command.
- **Never add amounts in different currencies.** All sums and aggregates are
  reported per currency, on purpose — a total across currencies is not a
  correct number. If the user needs one total, run `zm rates`, convert
  explicitly yourself, and label the result as an estimate at current rates
  (not historical rates, and not what ZenMoney reports).
- **`tx.amount` is always positive.** What it means depends on `tx.type`:
  `expense` (money out), `refund` (money back on a previous expense — still
  reported as a positive amount, not a negative one), `income` (money in),
  `transfer` and `debt` (moves between the user's own accounts/debts — see
  `counterpart` for the other side). "Spend" is not simply "every `tx` row":
  `spend = sum(expense.amount) - sum(refund.amount)`, computed per category
  and per currency (this is exactly what `zm spend`/`zm compare`/`zm budget
  status` report). A group's `count` in `zm spend`/`zm income` includes both
  expense and refund transactions, not just expenses, even though refunds
  subtract from the total. To reproduce a `spend` figure from raw `tx` rows
  yourself, filter to `type in (expense, refund)` and net them with that
  sign — never just sum `amount` across both types.
- ZenMoney itself is never modified by this CLI — no operations, no
  categories, no ZenMoney-side budgets are ever written.
- Budget files live in `~/.config/zm/budget/` (`default.yaml` plus optional
  `YYYY-MM.yaml` overrides). Only write or edit them when the user explicitly
  asks for a budget to be created or changed.

## Command reference

All commands accept `--format json|table` (default `json`). `--owner
<value>` is also a global flag — see "run `zm owners` first" above for its
two modes — but `categories`, `rates`, and `owners` reject any value other
than `all` (exit 2, `INVALID_ARGS`) since none of the three has a
per-owner concept — `--owner all`, the default, is accepted as a no-op;
every other command accepts it, though it only has an effect on `users`,
`accounts`, `tx`, `spend`, `income`, `compare`, `recurring`, `budget
status`, and `budget suggest` (`auth`, `sync`, `status`, and `budget init`
accept it but it has no effect on any of them). `users` always keeps
ZenMoney-user semantics for `--owner`, but once `owners.yaml` exists it
*also* rejects any non-`all` value outright (exit 2, hint pointing to `zm
owners`) rather than silently keep applying `me`/login/id semantics.
Beyond `--format`, flags differ by command — they are not uniform across
"filtering commands":

- `--from YYYY-MM-DD`, `--to YYYY-MM-DD`, `--month YYYY-MM` (a period
  filter): only `tx`, `spend`, `income`.
- `--category <query>` — category path, id, or unique leaf title (a parent
  category includes its children),
  `--account <name|id>`, `--currency <code>`: `tx`, `spend`, `income`,
  `compare`, `recurring` — not any `budget` subcommand.
- `compare` takes `--period <p> --vs <p>` instead of `--from/--to/--month`.
- `recurring` takes `--months`/`--min-months` for its window, which is always
  relative to now — it has no period flags at all.
- `budget status` and `budget suggest` take a single `--month` (a target
  month, not a range) and no `--category/--account/--currency`.

Run `zm <command> --help` for the exact flags and examples of any command.

| Command | Key flags | `data` shape |
|---|---|---|
| `zm auth` | `--token`, `--logout` | `{ saved: "keychain"\|"config" }` or `{ removed: true }` — if a Keychain was available but the write to it failed, `saved` is `"config"` and a `warnings` entry says so |
| `zm sync` | `--full` | `{ upserted, deleted, full }` — `upserted` is a per-entity map of counts (e.g. `{ transaction: 12 }`), `deleted` is one total count across all entities, `full` mirrors `--full` |
| `zm status` | – | `{ cache: { path, exists, readable, lastSyncAt, ageHours, error? }, token: { source: "env"\|"keychain"\|"config"\|null }, configDir, budgetDir, ownersFile: { path, exists, valid, error? }, version }` — no network call, works with no token and no cache, never writes to the real cache file or its directory (reads a private temp copy instead, including any uncheckpointed WAL data; a copy torn by a concurrent write is retried a few times before `readable: false`), never prints the token itself, only its `source`; `ownersFile.valid` is `false` (with an `error`) for a broken/unreadable owners.yaml, checked independent of the cache |
| `zm users` | – | `[{ id, login, currency, isMain }]` |
| `zm accounts` | `--archived` | `[{ id, title, type, currency, balance, inBalance, archived, owner }]` — `owner` is the `owners.yaml` owner name (or `null` if unassigned) once that file exists, else the ZenMoney login |
| `zm owners` | `--archived` | `{ file: path\|null, owners: [{ name, accounts: [{ id, title }] }], unassigned: [{ id, title }] }` — reads the cache and `owners.yaml`, no network; run this first before using `--owner` by name (see "Rules for agents" above); `--format table` renders `{ owner, id, title }` rows, `(unassigned)` for unassigned accounts; `warnings` flag an entry matching zero accounts, an entry matching more than half of all accounts, and an archived-account conflict resolved as unassigned |
| `zm categories` | `--tree` | `[{ id, path, parentId, kind }]`, or nested `{ ...,children: [...] }` with `--tree` |
| `zm rates` | – | `[{ currency, rate }]` relative to the main user's currency; `meta.note` marks it as current, not historical |
| `zm tx` | `--from/--to/--month`, `--category/--account/--currency`, `--type`, `--search`, `--limit` (default 100) | `[{ id, date, type, amount, currency, categoryPath, merchant, payee, accountTitle, hold, originalPayee, ownerId, owner, ... }]` — `hold` (boolean) marks a not-yet-settled ZenMoney transaction, counted normally; `owner` is the `owners.yaml` owner name (`null` with no file or when unassigned), independent of `ownerId` (always the raw ZenMoney user id); `meta.total`/`meta.returned` say whether the list was cut off |
| `zm spend` | `--from/--to/--month`, `--category/--account/--currency`, `--by category\|month\|merchant`, `--tree` | `[{ key, amounts: [{ currency, amount, count }], children? }]` — `--by merchant` uses the same merchant -> payee -> originalPayee -> comment fallback as `zm recurring`; the `(no merchant)` bucket only appears when all four are empty |
| `zm income` | `--from/--to/--month`, `--category/--account/--currency`, `--by category\|month` | same shape as `spend`, income transactions only |
| `zm compare` | `--category/--account/--currency`, `--period`, `--vs`, `--by total\|category` | `[{ key, currency, period, vs, diff, diffPct }]` |
| `zm recurring` | `--category/--account/--currency`, `--months`, `--min-months` | `[{ merchant, source, categoryPath, currency, monthsSeen, windowMonths, avgAmount, lastAmount, lastDate, periodicity }]` — `merchant` falls back through merchant -> payee -> originalPayee -> comment (real ZenMoney expenses often have only a comment, e.g. "Netflix"); `source` says which field it came from |
| `zm budget init` | `--force` | `{ file }` — writes a commented `default.yaml` template |
| `zm budget status` | `--month` | `{ month, monthElapsedPct, rows: [{ category, categoryId, currency, planned, spent, spentOtherCurrencies, remaining, usedPct, monthElapsedPct, pace }], unplanned, unresolved: [{ key, amount, currency }] }` — a limit key that no longer resolves to any category is skipped (with a warning) rather than failing the command, and listed in `unresolved` |
| `zm budget suggest` | `--months` (default 3), `--month` (default next month) | prints a draft yaml to stdout (not JSON, not written to a file) |

## Recipes

**Monthly review**
```
zm spend --by category --month 2026-09
zm compare --period 2026-09 --vs 2026-08 --by category
zm budget status
```

**Split spend by family member**
```
zm owners
zm spend --by category --month 2026-09 --owner robin
```
`zm owners` shows whether `owners.yaml` exists and, if so, its owner names
and which accounts map to each (plus `unassigned`). Use one of those names
with `--owner`; with no `owners.yaml`, fall back to `--owner me|<login>`
from `zm users` instead — don't guess which mode applies.

**Find subscriptions**
```
zm recurring --months 6
```
Looks for the same merchant + category recurring in at least 3 of the last 6
months. "Merchant" falls back through merchant -> payee -> originalPayee ->
comment, since real ZenMoney expenses often have no resolved merchant or
payee and only a free-form comment (e.g. "Netflix", "iCloud").

**Plan next month**
```
zm budget suggest > draft.yaml
```
Review the draft with the user, then save it as
`~/.config/zm/budget/YYYY-MM.yaml` (a one-month override) or fold agreed
changes into `~/.config/zm/budget/default.yaml` (the standing template).
A month file merges over `default.yaml` key by key (not by resolving what
category each key means), so **write each category key exactly as it is
spelled in `default.yaml`** — a differently-spelled key for the same category
(e.g. `Cafe` vs `Food/Cafe`) makes `budget status` fail with an error, rather
than silently overriding the existing row. Finish with `zm budget status
--month YYYY-MM` to confirm it parses and matches what was discussed.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected error |
| 2 | invalid arguments, invalid/unknown budget yaml, or a missing budget file |
| 3 | no token, ZenMoney rejected the token (401/403), or the token could not be stored |
| 4 | network or ZenMoney API error |
| 5 | no local cache (run `zm sync`), or the cache is corrupted (delete it and run `zm sync --full`) |
| 6 | cache is busy (another `zm sync` is running) — retry in a few seconds |

On failure, stderr carries `{"error": {"code", "message", "hint"}}` (plain
text with `--format table`).
