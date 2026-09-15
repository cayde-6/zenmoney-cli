# zenmoney-cli

[![CI](https://github.com/cayde-6/zenmoney-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/cayde-6/zenmoney-cli/actions/workflows/ci.yml)

A read-only command-line client for [ZenMoney](https://zenmoney.ru/): `zm`
reads your transactions, accounts and categories and reports spend, income,
comparisons and recurring payments — always per currency, never mixed —
plus a local, file-based monthly budget checked against your actual spend.

## Why

- **Read-only.** `zm` never writes anything back to ZenMoney: no
  transactions, no categories, no ZenMoney-side budgets. The only things it
  writes locally are its own cache and, if you ask it to, budget yaml files.
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
- Everything except `zm auth`/`zm sync` runs fully offline, against a local
  SQLite cache.

## Install

```
npm i -g zenmoney-cli   # once published
```

From source:

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
Remove a stored token with `zm auth --logout`.

A few example commands, with real output shape (from a small neutral
account: two users `owner`/`partner`, currencies PLN/EUR, categories like
Продукты/Кафе/Подписки, merchants like FreshMart/Netflix):

**Spend by category for a month** (a few of the returned groups shown):

```
$ zm spend --by category --month 2026-09
```

```json
{
  "data": [
    { "key": "Еда/Кафе", "amounts": [{ "currency": "EUR", "amount": 20, "count": 1 }] },
    { "key": "Подписки", "amounts": [{ "currency": "EUR", "amount": 12, "count": 1 }] },
    { "key": "Продукты", "amounts": [{ "currency": "PLN", "amount": 4500, "count": 3 }] }
  ],
  "meta": { "by": "category", "from": "2026-09-01", "to": "2026-09-30", "category": null, "owner": "all", "account": null, "currency": null, "lastSyncAt": "2026-09-20T12:00:00.000Z" }
}
```

**Transactions as a table** (a few columns shown; `tx` also returns `accountId`,
`ownerId`, `categoryId`, `topCategoryId`, `categoryPath`, `payee`, `comment`,
and, for transfers/debts, `counterpartAccount`/`counterpartAmount`/`counterpartCurrency`
flattened columns — in JSON these are a nested `counterpart: { accountId,
accountTitle, amount, currency }` object instead). `tx` returns at most 100
rows by default (`--limit` to change it); `meta.total` and `meta.returned`
tell you whether the list was cut off:

```
$ zm tx --category Продукты --limit 3 --format table
id  date        type     amount  currency  accountTitle  merchant
t5  2026-09-10  refund   500     PLN       Card PLN      FreshMart
t2  2026-09-05  expense  2000    PLN       Card Partner  CornerShop
t1  2026-09-02  expense  3000    PLN       Card PLN      FreshMart
```

**Compare two months by category** (a few of the returned rows shown):

```
$ zm compare --period 2026-09 --vs 2026-08 --by category
```

```json
{
  "data": [
    { "key": "Подписки", "currency": "EUR", "period": 12, "vs": 12, "diff": 0, "diffPct": 0 },
    { "key": "Продукты", "currency": "PLN", "period": 4500, "vs": 45000, "diff": -40500, "diffPct": -90 }
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
    { "merchant": "Netflix", "categoryPath": "Подписки", "currency": "EUR", "monthsSeen": 4, "windowMonths": 6, "avgAmount": 12, "lastAmount": 12, "lastDate": "2026-09-15", "periodicity": "monthly" }
  ],
  "meta": { "months": 6, "minMonths": 3, "from": "2026-04", "to": "2026-09", "category": null, "account": null, "currency": null, "owner": "all", "lastSyncAt": "2026-09-20T12:00:00.000Z" }
}
```

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
      { "category": "Еда/Кафе", "categoryId": "cafe", "currency": "EUR", "planned": 50, "spent": 20, "spentOtherCurrencies": [], "remaining": 30, "usedPct": 40, "monthElapsedPct": 50, "pace": -10 },
      { "category": "Подписки", "categoryId": "subs", "currency": "EUR", "planned": 15, "spent": 12, "spentOtherCurrencies": [], "remaining": 3, "usedPct": 80, "monthElapsedPct": 50, "pace": 30 }
    ]
  }
}
```

## Command reference

```
zm auth [--token <token>] [--logout]
zm sync [--full]
zm users
zm accounts [--archived]
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
```

Run `zm <command> --help` for the exact flags and worked examples of any
single command — that output is generated from the real CLI, so it is
always in sync with the installed version.

## Global options & filters

All commands accept global `--format json|table` (default `json`) and
`--owner me|all|<id>|<login>` (default `all`) — though `categories` and
`rates` reject `--owner` outright (see below) rather than accepting and
ignoring it.

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
- `categories` and `rates` reject `--owner` with exit code 2 (neither has a
  per-owner concept), rather than silently ignoring it. Elsewhere, `--owner`
  only has an effect on `users`, `accounts`, `tx`, `spend`, `income`,
  `compare`, `recurring`, `budget status`, and `budget suggest` — `auth` and
  `sync` accept the flag but ignore it.

## Budget files

Budget files live in `~/.config/zm/budget/`: a `default.yaml` template plus
optional `YYYY-MM.yaml` files for month-specific overrides.

```yaml
# default.yaml
currency: PLN
limits:
  Продукты: 2000
  Кафе: 800
  Подписки: { amount: 40, currency: EUR }
  Хобби: 300
```

```yaml
# 2026-10.yaml — only differences from the template
limits:
  Путешествия: { amount: 300, currency: EUR }
  Хобби: null
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
(e.g. `Кафе` and `Еда/Кафе`, if both name the same category) are a hard
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
   for spend in categories with no limit.
4. `zm budget suggest` prints a draft budget (based on median monthly
   spend over full months before the target month) to stdout — it never
   writes a file. Review it, then save it as a month override or fold it
   into `default.yaml`.

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
| 5 | no local cache (run `zm sync`) |

Errors are printed to stderr as `{"error": {"code", "message", "hint"}}`
(plain text with `--format table`).

## Privacy & security

- All data stays on your machine. Config and budget files live in
  `~/.config/zm/` (`config.json`, `budget/*.yaml`), honoring
  `XDG_CONFIG_HOME` if set (`%APPDATA%\zm` on Windows). The local cache (a
  SQLite file, built from `zm sync`) lives in `~/.cache/zm/zm.sqlite`,
  honoring `XDG_CACHE_HOME` if set (`%LOCALAPPDATA%\zm` on Windows).
- The only network calls this CLI makes are to `api.zenmoney.ru`, and only
  from `zm auth` (to validate a token) and `zm sync` (to download changes).
- On macOS, `zm auth` prefers storing the token in the Keychain (service
  `zenmoney-cli`) over `config.json`; `config.json` is written with mode
  `600` when the Keychain isn't used. A stored token is only looked up by
  commands that call the ZenMoney API — in practice just `zm sync` (`zm
  auth` validates whatever token you just gave it, before saving it, rather
  than looking up a previously stored one). Every read command works purely
  off the local cache and never touches the token at all. The lookup order,
  when it happens, is: `ZENMONEY_TOKEN` env var, then macOS Keychain, then
  `config.json`. Set `ZM_DISABLE_KEYCHAIN=1` to skip the Keychain entirely
  (e.g. in sandboxes without `security` access) and fall back to
  `config.json`.

## Using with AI agents

See [`SKILL.md`](./SKILL.md) for a CLI reference and recipes aimed at LLM
agents (also linked from `zm --help`).

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, scripts, and
conventions, and [`docs/architecture.md`](docs/architecture.md) for how the
CLI is built and why.

## License

[MIT](LICENSE)
