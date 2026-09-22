# zenmoney-cli

[![Release](https://github.com/cayde-6/zenmoney-cli/actions/workflows/release.yml/badge.svg)](https://github.com/cayde-6/zenmoney-cli/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@cayde-6/zenmoney-cli)](https://www.npmjs.com/package/@cayde-6/zenmoney-cli)
[![npm downloads](https://img.shields.io/npm/dm/@cayde-6/zenmoney-cli)](https://www.npmjs.com/package/@cayde-6/zenmoney-cli)
[![CI](https://github.com/cayde-6/zenmoney-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/cayde-6/zenmoney-cli/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/cayde-6/zenmoney-cli/branch/main/graph/badge.svg)](https://codecov.io/gh/cayde-6/zenmoney-cli)

A command-line client for [ZenMoney](https://zenmoney.ru/): `zm` reads your
transactions, accounts and categories and reports spend, income,
comparisons and recurring payments — always per currency, never mixed —
plus a local, file-based monthly budget checked against your actual spend.
It can also edit, add, and delete transactions, dry-run first.

## Why

- **Dry-run first.** `zm` only writes to ZenMoney with `--apply --expect
  <token>` from a dry-run you have seen; only transactions are ever
  written. Every other write is local: its own cache and, if you ask it
  to, budget yaml files. See "Writing transactions" below.
- **Per-currency, on purpose.** Amounts in different currencies are never
  added together. Every aggregate is reported per currency — a mixed total
  is a different, error-prone kind of number, so it's left to you (or your
  agent) to compute explicitly and label as an estimate.
- **Built for agents.** Every command prints a stable `{ data, meta,
  warnings? }` JSON envelope, errors are structured JSON on stderr with
  stable exit codes, and [`SKILL.md`](SKILL.md) documents the CLI for LLM
  agents specifically (also linked from `zm --help`).

## Features

- Transactions with filters: date range or month, category (a parent
  includes its subcategories), account, currency, owner, transaction type,
  free-text search.
- Spend and income aggregated by category (optionally as a parent/children
  tree), by month, or by merchant.
- Period-over-period comparison, by total or by category.
- Recurring payment / subscription detection.
- A local yaml budget: generate a template from your real categories, check
  plan vs. actual with pace, and get a draft budget suggested from your
  spending history.
- `--format json` (default, for scripts and agents) or `--format table`
  (for humans).
- Editing, adding, and deleting transactions (`zm edit`/`zm add`/`zm
  delete`), dry-run by default — see "Writing transactions" below.
- Every read command, and every dry-run, runs fully offline, against a
  local SQLite cache; only `zm auth`, `zm sync`, and `--apply` on a write
  command make a network call.

## Install

### From npm

```
npm i -g @cayde-6/zenmoney-cli   # once published
zm --help
```

Or run it without installing anything:

```
npx @cayde-6/zenmoney-cli --help
```

### From source

```
git clone https://github.com/cayde-6/zenmoney-cli.git
cd zenmoney-cli
npm ci
npm run build
npm link
```

Requires Node.js >= 22.13.

## Getting a token

`zm auth` needs a ZenMoney API access token. See the official API
description for how to obtain one:
https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API

## Quick start

```
zm auth              # prompts for the token (hidden input) on a TTY
zm sync              # download your data into a local cache
```

`zm auth` also accepts the token piped via stdin (`echo XXX | zm auth`) or
via `--token XXX` — prefer the prompt or stdin over `--token`, since a
`--token` value ends up in shell history and is visible to other processes
via the process list (`ps`).

The token can also be supplied without running `zm auth` at all, via the
`ZENMONEY_TOKEN` environment variable — useful in CI or for one-off scripts.
Remove a stored token with `zm auth --logout` (this warns if `ZENMONEY_TOKEN`
is still set in the environment, since it takes precedence and will still be
used even after logout).

`zm status` reports cache/token/config state — cache path, whether it
exists, whether it's readable (plus an `error` message when it isn't),
`lastSyncAt`/`ageHours`, where a token would be found (`env` | `keychain` |
`config` | `null` — never the token value itself), `configDir`, `budgetDir`,
and the installed version. It makes no network call, works with no token
and no cache at all, and never writes to the real cache file or its
directory: it copies the cache (and its `-wal` file, if present) into a
private temp directory and reads that copy instead, so any data a `zm sync`
has committed but not yet checkpointed is included, and the real cache is
only ever read from, never modified. A snapshot that a concurrent write
happened to tear (caught by comparing the cache's size/`-wal` header before
and after copying it, and by an integrity check on the copy itself) is
retried a few times with a fresh copy before giving up with a "retry
shortly" message — the temp directory is always removed again afterwards.
So it's always safe to run first when something else isn't working.

A few example commands, with real output shape (from a small neutral
account: two users `owner`/`partner`, currencies PLN/EUR, categories like
Groceries/Cafe/Subscriptions, merchants like FreshMart/Netflix):

**Spend by category for a month** (a few of the returned groups shown):

```
$ zm spend --by category --month 2026-09
```

```json
{
  "data": [
    { "key": "Food/Cafe", "amounts": [{ "currency": "EUR", "amount": 20, "count": 1 }] },
    { "key": "Groceries", "amounts": [{ "currency": "PLN", "amount": 4500, "count": 3 }] },
    { "key": "Subscriptions", "amounts": [{ "currency": "EUR", "amount": 12, "count": 1 }] }
  ],
  "meta": { "by": "category", "from": "2026-09-01", "to": "2026-09-30", "category": null, "owner": "all", "account": null, "currency": null, "lastSyncAt": "2026-09-20T12:00:00.000Z" }
}
```

**Transactions as a table** (a few columns shown; `tx` also returns `accountId`,
`ownerId`, `owner` (the owners.yaml owner name, or `null` with no
owners.yaml or an unassigned account — see "Owners" below), `categoryId`,
`topCategoryId`, `categoryPath`, `payee`, `comment`,
`hold` (boolean — a not-yet-settled ZenMoney transaction, counted normally),
`originalPayee`, and, for transfers/debts, `counterpartAccount`/
`counterpartAmount`/`counterpartCurrency` flattened columns — in JSON these
are a nested `counterpart: { accountId, accountTitle, amount, currency }`
object instead). `tx` returns at most 100 rows by default (`--limit` to
change it); `meta.total` and `meta.returned` tell you whether the list was
cut off:

```
$ zm tx --category Groceries --limit 3 --format table
id  date        type     amount  currency  accountTitle  merchant   payee
t5  2026-09-10  refund   500     PLN       Card PLN      FreshMart
t2  2026-09-05  expense  2000    PLN       Card Partner             CornerShop
t1  2026-09-02  expense  3000    PLN       Card PLN      FreshMart
```

(t2's `payee` is `CornerShop` with no resolved `merchant` — the two fields
are independent; `merchant` is `null`/blank rather than falling back to the
payee text. `zm recurring` and `zm spend --by merchant` do fall back to
`payee`, see below.)

**Compare two months by category** (a few of the returned rows shown):

```
$ zm compare --period 2026-09 --vs 2026-08 --by category
```

```json
{
  "data": [
    { "key": "Groceries", "currency": "PLN", "period": 4500, "vs": 45000, "diff": -40500, "diffPct": -90 },
    { "key": "Subscriptions", "currency": "EUR", "period": 12, "vs": 12, "diff": 0, "diffPct": 0 }
  ],
  "meta": { "by": "category", "period": "2026-09", "vs": "2026-08", "category": null, "account": null, "currency": null, "owner": "all", "lastSyncAt": "2026-09-20T12:00:00.000Z" }
}
```

**Find recurring payments:**

```
$ zm recurring --months 6
```

```json
{
  "data": [
    { "merchant": "Netflix", "source": "merchant", "categoryPath": "Subscriptions", "currency": "EUR", "monthsSeen": 4, "windowMonths": 6, "avgAmount": 12, "lastAmount": 12, "lastDate": "2026-09-15", "periodicity": "monthly" }
  ],
  "meta": { "months": 6, "minMonths": 3, "from": "2026-04", "to": "2026-09", "category": null, "account": null, "currency": null, "owner": "all", "lastSyncAt": "2026-09-20T12:00:00.000Z" }
}
```

Real ZenMoney expenses often have no resolved merchant and no payee at all —
the only text is a free-form comment (e.g. `"Netflix"`, `"Telegram Premium"`,
`"iCloud"`). `recurring` (and `spend --by merchant`) fall back through
`merchant` -> `payee` -> `originalPayee` -> `comment`, using the first
non-empty one; `source` says which field it came from. Both commands group
by the same case-insensitive, whitespace-collapsed key, so e.g. `"Netflix"`
and `"netflix "` land in one group in both — displayed using the spelling
from the group's most recent transaction.

**Budget status for a month** (from a `default.yaml` with a couple of
limits set; `unplanned` and the rest of `meta` omitted here for brevity):

```
$ zm budget status --month 2026-09
```

```json
{
  "data": {
    "month": "2026-09",
    "monthElapsedPct": 50,
    "rows": [
      { "category": "Food/Cafe", "categoryId": "cafe", "currency": "EUR", "planned": 50, "spent": 20, "spentOtherCurrencies": [], "remaining": 30, "usedPct": 40, "monthElapsedPct": 50, "pace": -10 },
      { "category": "Subscriptions", "categoryId": "subs", "currency": "EUR", "planned": 15, "spent": 12, "spentOtherCurrencies": [], "remaining": 3, "usedPct": 80, "monthElapsedPct": 50, "pace": 30 }
    ]
  }
}
```

## Command reference

```
zm auth [--token <token>] [--logout]
zm sync [--full]
zm status
zm users
zm accounts [--archived]
zm owners [--archived]
zm categories [--tree]
zm rates
zm tx [filters] [--type <types>] [--search <text>] [--limit <n>]  # default 100
zm spend --by category|month|merchant [--tree] [filters]
zm income --by category|month [filters]
zm compare --period <P> --vs <P> [--by total|category]
zm recurring [--months <n>] [--min-months <n>]
zm budget init [--force]
zm budget status [--month <YYYY-MM>]
zm budget suggest [--months <n>] [--month <YYYY-MM>]
zm edit <ids...> [--comment <text>] [--payee <text>] [--category <query>] [--date <date>] [--amount <n>] [--account <query>] [--apply --expect <token>]
zm add (--expense <n>|--income <n>) --account <query> [--category <query>] [--date <date>] [--comment <text>] [--payee <text>] [--id <uuid>] [--apply --expect <token>]
zm delete <ids...> [--apply --expect <token>]
```

Run `zm <command> --help` for the exact flags and worked examples of any
single command — that output is generated from the real CLI, so it is
always in sync with the installed version.

## Global options & filters

All commands accept global `--format json|table` (default `json`) and
`--owner <value>` (default `all`) — though `categories`, `rates`,
`owners`, `zm edit`, `zm add`, and `zm delete` reject any `--owner` value
other than `all` (see below) rather than accepting and ignoring it.
`--owner` has two different sets of valid
values, depending on whether `<configDir>/owners.yaml` exists — see
"Owners" below for the full explanation:

- **No `owners.yaml`** (the default, and everything before this feature):
  `me|all|<id>|<login>`. `me` is the main user of the family account (the
  ZenMoney user with no parent) — not necessarily whoever's API token the
  CLI is using; run `zm users` to see who's who.
- **`owners.yaml` exists**: `all|unassigned|<name>`, where `<name>` is one
  of the file's own owner names (run `zm owners` to see them) — `me`,
  logins, and ids are no longer accepted.

Beyond that, flags are command-specific, not uniform across "filtering
commands":

- `--from YYYY-MM-DD`, `--to YYYY-MM-DD`, `--month YYYY-MM` (a period
  filter): only `tx`, `spend`, `income`.
- `--category <query>` — category path, id, or unique leaf title (a parent
  category includes its subcategories), `--account <name|id>`, `--currency <code>`: `tx`,
  `spend`, `income`, `compare`, `recurring` — not any `budget` subcommand.
- `compare` takes `--period <p> --vs <p>` instead of `--from/--to/--month`.
- `recurring` takes `--months`/`--min-months` for its window, which is
  always relative to now — it has no period flags at all.
- `budget status`/`budget suggest` take a single `--month` (a target
  month, not a range) and no `--category`/`--account`/`--currency`.
- `categories`, `rates`, and `owners` reject any `--owner` value other
  than `all` with exit code 2 (none of the three has a per-owner concept —
  `owners` *lists* owners, it isn't filtered by one), rather than silently
  ignoring it — `--owner all` (the default) is accepted since it's a
  no-op. `zm edit`, `zm add`, and `zm delete` reject any `--owner` value
  other than `all` the same way (exit 2) — they target explicit
  transaction ids, not an owner-filtered set, so there's nothing for
  `--owner` to do. Elsewhere, `--owner` only has an effect on `users`,
  `accounts`, `tx`, `spend`, `income`, `compare`, `recurring`, `budget
  status`, and `budget suggest` — `auth`, `sync`, `status`, and `budget
  init` accept the flag but it has no effect on any of them.
- `users` is always filtered by ZenMoney-user semantics
  (`me|all|<id>|<login>`), never by `owners.yaml` names — but once
  `owners.yaml` exists, it *also* rejects any non-`all` value outright
  (exit 2, hint pointing to `zm owners`), the same way `categories`/`rates`
  always do, rather than silently keep applying `me`/login/id semantics as
  if nothing had changed. A file owner name has no natural mapping onto
  ZenMoney's own (usually one or two row) user list — that mismatch is
  exactly why `owners.yaml` exists for accounts/tx in the first place.

## Owners

Some ZenMoney family accounts have no per-account ownership data at all:
every account, transaction, tag, and merchant carries the same `user` (the
family's main user), `role` is null, and `private` is false everywhere. In
that shape `--owner <login>` can't separate family members — everything
resolves to one person — even though the family itself distinguishes
accounts by eye, typically with a naming convention like an emoji prefix
per person.

An optional `<configDir>/owners.yaml` (`~/.config/zm/owners.yaml` on
Linux/macOS) fixes this locally:

```yaml
# owners.yaml
owners:
  robin:
    accounts: ["🚗 Robin", "acc-id-123"]
  sam:
    accounts: ["Sam"]
```

Each `accounts` entry matches an account if it equals the account id
exactly, or matches the account title (after trimming). Title matching has
two modes: an entry containing at least one letter or digit that isn't
*only* part of a keycap emoji (see below) is a plain case-insensitive
substring match; a *bare emoji/symbol* entry instead has to align to whole
Unicode grapheme-cluster boundaries in the title — so a bare "👨" does
**not** match inside a "👨‍👩 Joint" title (that's one grapheme, a
ZWJ-joined family), a skin-toned emoji only matches by its full sequence,
never by its bare base emoji, and a keycap digit (digit + U+FE0F + U+20E3) is never treated
as if it were the plain text "1". **Copy the emoji straight from the
account title** (as `zm owners` prints it) rather than retyping it —
matching is otherwise exact once variation selectors are stripped and both
sides are Unicode-normalized. (Intl.Segmenter, needed only for this
grapheme-boundary check, is constructed the first time an emoji/symbol
entry is actually matched — a plain text-only owners.yaml works even on a
Node build without full ICU support.) Only the owner *name* itself is
restricted to `[A-Za-z][A-Za-z0-9._-]*` (must start with a letter), can't
be `all` or `unassigned` (both are reserved `--owner` values once the file
exists), must be written as a real yaml string key (a bare numeric key
like `123:` is rejected, not silently stringified), and can't equal
another owner's name case-insensitively (`Alex` and `alex` in the same
file is a hard error — `--owner` matches names case-insensitively, so the
two would be genuinely ambiguous).

An account matched by entries from two different owners is a hard error
everywhere except `zm owners` itself (`INVALID_ARGS`, naming the account
and every matching owner, hint: `pin it to one owner by account id; run zm
owners to see all conflicts`) — *unless* the account is archived, in which
case the conflict is downgraded to a `warnings` entry and the account is
treated as unassigned, so one stale closed account can never break every
other command that opens the cache. `zm owners` is the exception because
it's the diagnostic tool that hint points to: instead of failing, it lists
each non-archived conflict under `data.conflicts: [{ id, title, owners }]`
(the account appears there only, never also under an owner or in
`unassigned`) plus a `warnings` entry, and still exits 0. An exact
account-id entry always wins over another owner's mere title match (no
conflict in that case). An account matched by no entry at all is
"unassigned". Matching itself always considers every account, archived
included — `--archived` only ever changes what a command *displays*.

Once `owners.yaml` exists:

- `--owner` switches from ZenMoney-user semantics to `all` (default) |
  `unassigned` | one of the file's own owner names, compared
  case-insensitively but always resolving to the file's own spelling — see
  "Global options & filters" above. An unrecognized name exits 2 with a
  hint listing every defined owner name (and the file's path) rather than
  a fuzzy top-3 guess. `zm users` is the one exception: it keeps ZenMoney-
  user semantics for everything *except* rejects any non-`all` value with a
  pointer to `zm owners`, since a family-member owner name has no natural
  mapping onto ZenMoney's own user list — and, since that check needs no
  file content, it reads owners.yaml at all only when `--owner` isn't
  `all`, so a broken file can never break the default `zm users`
  invocation.
- Every `tx` row gains an `owner` field (the owning account's owner name,
  or `null` when unassigned) alongside the existing `ownerId` (always the
  raw ZenMoney user id, regardless of `owners.yaml`).
- `zm accounts`' `owner` field reports the file's owner name (or `null`
  when unassigned) instead of the ZenMoney login.
- `budget status`, `budget suggest`, `spend`, `income`, `compare`,
  `recurring`, and `tx` all filter by the new `--owner` semantics through
  the shared filter path, and surface any archived-account conflict
  warning in their own `warnings`. Each of these commands' `meta.owner`
  (or, for `budget status`, its own `owner` meta field) echoes the file's
  resolved spelling — `--owner ALEX` reports `"alex"` — not the caller's
  casing.

With no `owners.yaml` at all, every command behaves exactly as before this
feature — `--owner` keeps its `me|all|<id>|<login>` semantics (echoed
as-is in `meta.owner`), `tx.owner` is always `null`, and `zm accounts`'
`owner` field stays the ZenMoney login. A directory (or otherwise
unreadable file) at `owners.yaml`'s path, or invalid yaml/shape, is a hard
`INVALID_ARGS` error naming the path — never a silent fallback to "no
file". `zm status`'s `ownersFile.valid` covers parsing only, though: it
never opens the cache, so it can't detect a genuine matching conflict —
`zm owners` is where that actually shows up.

**`zm owners`** (reads the local cache and `owners.yaml`, no network — run
this first to see the current mapping):

```
$ zm owners
```

```json
{
  "data": {
    "file": "/home/you/.config/zm/owners.yaml",
    "owners": [
      { "name": "robin", "accounts": [{ "id": "acc-id-123", "title": "🚗 Robin" }] },
      { "name": "sam", "accounts": [{ "id": "acc-id-456", "title": "Sam" }] }
    ],
    "unassigned": [{ "id": "acc-id-789", "title": "Joint Savings" }],
    "conflicts": []
  },
  "meta": { "lastSyncAt": "2026-09-20T12:00:00.000Z" }
}
```

With no `owners.yaml`, `data.file` is `null`, `data.owners` and
`data.conflicts` are `[]`, every non-archived account is listed under
`data.unassigned`, and a `warnings` entry explains how to create the file.
`--archived` includes archived accounts in both `owners[].accounts` and
`unassigned`. `--format table` renders one `{ owner, id, title }` row per
account, with a literal `(unassigned)` `owner` for accounts nothing
matched (a conflicted account appears in no row at all — only in
`data.conflicts`). Three kinds of `warnings` help catch a stale, ambiguous,
or overly-broad `owners.yaml`: a non-archived conflict (see above); an
entry that matches zero accounts (a likely typo, or a renamed/closed
account) — for any entry, emoji/symbol included; and, for a *short* text
entry only (at most 2 letters/digits, e.g. `"Ca"`), one that matches more
than half of *all* accounts (`entry "x" of owner y matches N of M
accounts`). A longer text entry, or an emoji/symbol entry, is never
flagged for over-matching: emoji/symbol entries require an exact
whole-grapheme match (see above), so they can't over-match by accident —
a shared emoji prefix across most or all accounts is a common, legitimate
naming convention, not noise.

## Budget files

Budget files live in `~/.config/zm/budget/`: a `default.yaml` template plus
optional `YYYY-MM.yaml` files for month-specific overrides.

```yaml
# default.yaml
currency: PLN
limits:
  Groceries: 2000
  Cafe: 800
  Subscriptions: { amount: 40, currency: EUR }
  Hobbies: 300
```

```yaml
# 2026-10.yaml — only differences from the template
limits:
  Travel: { amount: 300, currency: EUR }
  Hobbies: null
```

A limit is either a plain number or an explicit `{ amount, currency }`. A
plain number is priced in the currency declared by the *file it's written
in*: a numeric limit in `default.yaml` keeps the template's `currency` even
if a month file declares a different one, and a numeric limit added in a
month file uses that month file's own `currency`. `{ amount, currency }`
always uses its own explicit currency, in either file. The month file
overrides the template key by key: `null` removes a limit. A key is a
category path; a parent's limit covers its subcategories, but if a
subcategory has its own limit, that subcategory's spend counts only against
its own row, not the parent's. Two keys that resolve to the same category
(e.g. `Cafe` and `Food/Cafe`, if both name the same category) are a hard
error — write the same key spelling in both files.

Workflow:

1. `zm budget init` writes a commented `default.yaml` template from your
   current expense-capable categories.
2. Uncomment and fill in the limits you want (or run `zm budget suggest`
   first — see below — and copy from its output).
3. `zm budget status` reports plan vs. actual for the current (or a given)
   month: `planned`, `spent`, `remaining`, `usedPct`, `monthElapsedPct`,
   and `pace` (`usedPct - monthElapsedPct`; positive means spending faster
   than the month is progressing) per category, plus an `unplanned` block
   for spend in categories with no limit. A limit key that no longer
   resolves to any category (e.g. renamed or deleted in ZenMoney) is
   skipped with a warning instead of failing the command, and listed under
   `unresolved: [{ key, amount, currency }]`.
4. `zm budget suggest` prints a draft budget (based on median monthly
   spend over full months before the target month) to stdout — it never
   writes a file. Review it, then save it as a month override or fold it
   into `default.yaml`.

## Writing transactions

`zm edit`, `zm add`, and `zm delete` are the only commands that write to
ZenMoney, and they only ever write transactions — never accounts,
categories, or anything else. Every one of them is a dry-run by default:
it validates the request, computes what would change, and prints it
without making any network call. Nothing is written until you rerun the
exact `applyCommand` the dry-run printed, which carries `--apply --expect
<token>`:

```
$ zm edit t1 --comment Netflix
```

```json
{
  "data": {
    "applied": false,
    "token": "9f2c1a3b4d5e6f70",
    "applyCommand": "zm edit t1 --comment Netflix --apply --expect 9f2c1a3b4d5e6f70",
    "changes": [
      {
        "op": "update",
        "id": "t1",
        "before": { "id": "t1", "date": "2026-09-02", "type": "expense", "amount": 3000, "currency": "PLN", "accountId": "acc-pln", "accountTitle": "Card PLN", "categoryPath": "Groceries", "merchant": "FreshMart", "payee": null, "comment": null },
        "after": { "id": "t1", "date": "2026-09-02", "type": "expense", "amount": 3000, "currency": "PLN", "accountId": "acc-pln", "accountTitle": "Card PLN", "categoryPath": "Groceries", "merchant": "FreshMart", "payee": null, "comment": "Netflix" },
        "fields": ["comment"]
      }
    ],
    "balanceImpact": []
  },
  "meta": { "lastSyncAt": "2026-09-20T12:00:00.000Z" }
}
```

(`before`/`after` are full `Tx` rows — a few fields shown here for brevity; a
comment-only edit leaves `balanceImpact` empty, since it doesn't change any
account's balance.)

```
$ zm edit t1 --comment Netflix --apply --expect 9f2c1a3b4d5e6f70
```

### Plan token and retry safety

`token` is a hash of exactly what the dry-run would send (which
transactions, which raw fields, and their new values). `--apply` runs an
incremental sync first, recomputes the same plan against the freshly
synced cache, and only sends the write if the recomputed token still
matches `--expect`. A mismatch exits **7 (CONFLICT)**, with a hint to
rerun the dry-run and review the current state — this is what catches a
change made in the ZenMoney app, by another `zm` run, or by an
intervening `zm sync` since the dry-run. `zm edit --apply` also exits 7 if
the sync it just ran finds a target deleted or gone entirely.

Exit 7 isn't limited to `--apply`: `zm add --id <uuid>` also exits 7 on a
plain dry-run if that id already exists with different content (the same
check runs again during `--apply`, in case it exists by then even though
it didn't at dry-run time).

Because of that re-sync-and-recompute step, it's always safe to rerun the
exact same `--apply --expect <token>` command again after a transport
failure, an HTTP 5xx, or a malformed response from ZenMoney — exit **4
(NETWORK)** with the hint "the change may have been written; run the same
command again, it is safe to retry", since whether the write actually
landed is unknown. An HTTP 4xx response is different: ZenMoney rejected
the request outright before writing anything, so the hint instead says
"ZenMoney rejected the write; nothing was changed. Rerun without --apply
to review the plan" — retrying the identical `--apply` would just fail
again. A change that already matches its requested state is dropped from
the plan before the token is recomputed (`warnings: ["already in that
state: <ids>"]`); if every change in the plan already landed, the command
exits 0 with `applied: true` and `warnings: ["already applied"]`, and
nothing is sent again. A dry-run whose plan is empty for the same reason
(every target already matches the requested state) prints `applyCommand:
null` instead of a command to rerun — there is nothing to apply. `zm`
itself never retries automatically.

### What can be written

- `zm edit <ids...>`: `--comment`, `--payee`, `--category`, and `--date`
  work on any transaction; `--comment ""` and `--payee ""` clear the
  field. A non-empty `--payee` also clears any linked merchant (`--payee
  ""` clears only the payee — merchant is left alone). `--amount` and
  `--account` only work on a single-currency simple transaction
  (classified `expense`, `income`, or `refund`, same currency on both
  sides) — using either on a transfer, a debt, or a foreign-currency
  transaction fails the whole command with exit 2, with no partial edit.
- `zm add`: creates a new single-currency simple transaction — exactly one
  of `--expense`/`--income`, a required `--account`, and optional
  `--category`/`--date` (default: today)/`--comment`/`--payee`. Transfers,
  debts, and foreign-currency transactions can't be created, only edited
  (restricted fields above) or deleted. A dry-run without `--id` generates
  a UUID and includes it in the printed `applyCommand`, so retrying the
  same command always targets the same transaction; `--apply` requires
  `--id`.
- `zm delete <ids...>`: marks the transaction deleted in ZenMoney, the same
  as deleting it from the app. The dry-run's `changes[].raw` carries the
  full cached copy of each transaction that would be deleted — there is no
  separate local undo.
- `--owner` other than `all` is rejected by all three commands.

`balanceImpact` reports the net change to each affected account's balance,
per account and currency, never summed across currencies. It's a safety
net, not an authority: the ZenMoney server recomputes the real balance,
and if its response to `--apply` doesn't include an updated version of an
affected account, a `warnings` entry says to check that account in
ZenMoney. Similarly, if that response doesn't echo back one of the
transactions just written, a `warnings` entry names it and points at `zm
sync --full` to make sure the local cache matches ZenMoney — the write
already happened either way (the POST is what succeeded or failed, not
this check), and the payload sent is never written into the local cache
directly, only whatever the response actually confirms.

## Output & exit codes

Every read command prints `{ data, meta, warnings? }` as JSON (or a table
with `--format table`), except `zm budget suggest`, which prints a raw yaml
draft to stdout with no envelope, and puts warnings on stderr instead.
`meta.lastSyncAt` is present on every command that opens the local cache.
When the cache is more than 24 hours old, a `warnings` entry like `"cache
is 3 days old, run zm sync"` is added — the data is still returned.

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected error |
| 2 | invalid arguments, invalid/unknown budget yaml, or a missing budget file |
| 3 | no token, ZenMoney rejected the token (401/403), or the token could not be stored |
| 4 | network or ZenMoney API error |
| 5 | no local cache (run `zm sync`), or the cache file is unreadable/corrupted (delete it and run `zm sync --full`) |
| 6 | cache is busy (another `zm sync` is running) — retry in a few seconds |
| 7 | `zm add` (dry-run or `--apply`): the given `--id` already exists with different content. `zm edit`/`zm add`/`zm delete --apply`: the recomputed plan no longer matches `--expect` (or, for `edit`, a target was deleted or removed by the sync `--apply` just ran) — rerun the dry-run and review the current state |

Errors are printed to stderr as `{"error": {"code", "message", "hint"}}`
(plain text with `--format table`).

## Privacy & security

- All data stays on your machine. Config and budget files live in
  `~/.config/zm/` (`config.json`, `budget/*.yaml`), honoring
  `XDG_CONFIG_HOME` if set to an absolute path (`%APPDATA%\zm` on Windows).
  The local cache (a SQLite file, built from `zm sync`) lives in
  `~/.cache/zm/zm.sqlite`, honoring `XDG_CACHE_HOME` if set to an absolute
  path (`%LOCALAPPDATA%\zm` on Windows). A relative `XDG_CONFIG_HOME`/
  `XDG_CACHE_HOME` is invalid per the XDG spec and is ignored, falling back
  to the default.
- The only network calls this CLI makes are to `api.zenmoney.ru`, and only
  from `zm auth` (to validate a token), `zm sync` (to download changes),
  and `zm edit`/`zm add`/`zm delete --apply` (to sync, then write) — every
  other command, and every write command's dry-run, is fully offline.
- On macOS, `zm auth` prefers storing the token in the Keychain (service
  `zenmoney-cli`) over `config.json`; `config.json` is written atomically
  (a temp file at mode `600`, renamed into place) when the Keychain isn't
  used, and the config/cache/budget directories are created at mode `700`.
  The local cache database is chmodded to `600` after every open, and opens
  with `PRAGMA journal_mode=WAL`/`busy_timeout=5000` so concurrent `zm`
  invocations don't corrupt it (a still-locked cache surfaces as exit code
  6 rather than hanging). A stored token is only looked up by `zm sync`
  and `zm edit`/`zm add`/`zm delete --apply` (both call the API), and by
  `zm status` (to report where a token would come from — `zm status`
  never reads or prints the token's actual value, only its `source`);
  `zm auth` validates whatever token you just gave it, before saving it,
  rather than looking up a previously stored one. Every other read
  command, and every write command's dry-run, works purely off the local
  cache and never touches the token at all. The lookup order, when it
  happens, is: `ZENMONEY_TOKEN`
  env var, then macOS Keychain, then `config.json`. Set
  `ZM_DISABLE_KEYCHAIN=1` to skip the Keychain entirely (e.g. in sandboxes
  without `security` access) and fall back to `config.json`. If a Keychain
  is available but the write to it fails, `zm auth` still falls back to
  `config.json` (`{ "saved": "config" }`) and adds a `warnings` entry:
  `"could not store the token in macOS Keychain, saved to <configFile>
  instead"`.
- Network requests to `api.zenmoney.ru` (`zm auth`, `zm sync`, and `zm
  edit`/`zm add`/`zm delete --apply`) time out after `ZM_TIMEOUT_MS`
  milliseconds (default `60000`); it must be a positive integer, or the
  command fails fast with `INVALID_ARGS`.

## Using with AI agents

See [`SKILL.md`](./SKILL.md) for a CLI reference and recipes aimed at LLM
agents (also linked from `zm --help`).

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, scripts, and
conventions, and [`docs/architecture.md`](docs/architecture.md) for how the
CLI is built and why.

## Releases

Publishing is a manual version bump + git tag push, verified and published
by CI with npm provenance — no token stored in this repository. See
[`docs/versioning.md`](docs/versioning.md) for the semver rules and
one-time publishing setup, and
[`docs/release-checklist.md`](docs/release-checklist.md) for the exact
steps to cut a release.

## Repo docs

- [`SKILL.md`](SKILL.md) — command reference and recipes for LLM agents.
- [`docs/architecture.md`](docs/architecture.md) — data flow, classification,
  and design decisions.
- [`docs/versioning.md`](docs/versioning.md) — semver rules and one-time
  publishing setup.
- [`docs/release-checklist.md`](docs/release-checklist.md) — steps to cut a
  release.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, scripts, and conventions.
- [`SECURITY.md`](SECURITY.md) — supported versions and how to report a
  vulnerability.
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes, by version.

## License

[MIT](LICENSE)
