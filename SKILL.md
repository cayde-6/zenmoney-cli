---
name: zenmoney-cli
description: "Read a user's ZenMoney spending via the zm CLI: transactions, per-currency aggregates, recurring payments, and a local monthly budget. Use when asked to analyse spending, find subscriptions, or plan a budget."
---

# zenmoney-cli

`zm` is a read-only CLI over a user's ZenMoney data. It never writes to
ZenMoney — only to a local SQLite cache and local budget yaml files.

## Setup

```
npm i -g zenmoney-cli   # once published — see README.md for install-from-source
zm auth
zm sync
```

`zm auth` stores a ZenMoney API access token (macOS Keychain, or
`~/.config/zm/config.json` elsewhere). `zm sync` downloads the account into a
local cache; run it again any time to pick up new transactions.

## Rules for agents

- Every command prints a `{ data, meta, warnings? }` JSON envelope, **except
  `zm budget suggest`**, which prints a raw yaml draft to stdout (no
  envelope) and puts warnings on stderr as plain `warning: ...` lines instead.
- `meta.lastSyncAt` is present on every command that opens the local cache
  (all read commands, plus `zm sync` itself); `zm auth` has no
  `meta.lastSyncAt`. When the cache is stale, cache-reading commands also add
  a top-level `warnings` array with an entry like
  `"cache is 3 days old, run zm sync"`. If you see that warning, run
  `zm sync` before reporting numbers.
- **Never add amounts in different currencies.** All sums and aggregates are
  reported per currency, on purpose — a total across currencies is not a
  correct number. If the user needs one total, run `zm rates`, convert
  explicitly yourself, and label the result as an estimate at current rates
  (not historical rates, and not what ZenMoney reports).
- ZenMoney itself is never modified by this CLI — no operations, no
  categories, no ZenMoney-side budgets are ever written.
- Budget files live in `~/.config/zm/budget/` (`default.yaml` plus optional
  `YYYY-MM.yaml` overrides). Only write or edit them when the user explicitly
  asks for a budget to be created or changed.

## Command reference

All commands accept `--format json|table` (default `json`). `--owner
me|all|<id>|<login>` is also a global flag, but `categories` and `rates`
reject it outright (exit 2, `INVALID_ARGS`) since neither has a per-owner
concept; every other command accepts it, though it only has an effect on
`users`, `accounts`, `tx`, `spend`, `income`, `compare`, `recurring`,
`budget status`, and `budget suggest` (`auth` and `sync` accept but ignore
it). Beyond `--format`, flags differ by command — they are not uniform
across "filtering commands":

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
| `zm auth` | `--token`, `--logout` | `{ saved: "keychain"\|"config" }` or `{ removed: true }` |
| `zm sync` | `--full` | `{ upserted, deleted, full }` — `upserted` is a per-entity map of counts (e.g. `{ transaction: 12 }`), `deleted` is one total count across all entities, `full` mirrors `--full` |
| `zm users` | – | `[{ id, login, currency, isMain }]` |
| `zm accounts` | `--archived` | `[{ id, title, type, currency, balance, inBalance, archived, owner }]` |
| `zm categories` | `--tree` | `[{ id, path, parentId, kind }]`, or nested `{ ...,children: [...] }` with `--tree` |
| `zm rates` | – | `[{ currency, rate }]` relative to the main user's currency; `meta.note` marks it as current, not historical |
| `zm tx` | `--from/--to/--month`, `--category/--account/--currency`, `--type`, `--search`, `--limit` (default 100) | `[{ id, date, type, amount, currency, categoryPath, merchant, payee, accountTitle, ... }]` — `meta.total`/`meta.returned` say whether the list was cut off |
| `zm spend` | `--from/--to/--month`, `--category/--account/--currency`, `--by category\|month\|merchant`, `--tree` | `[{ key, amounts: [{ currency, amount, count }], children? }]` |
| `zm income` | `--from/--to/--month`, `--category/--account/--currency`, `--by category\|month` | same shape as `spend`, income transactions only |
| `zm compare` | `--category/--account/--currency`, `--period`, `--vs`, `--by total\|category` | `[{ key, currency, period, vs, diff, diffPct }]` |
| `zm recurring` | `--category/--account/--currency`, `--months`, `--min-months` | `[{ merchant, categoryPath, currency, monthsSeen, windowMonths, avgAmount, lastAmount, lastDate, periodicity }]` |
| `zm budget init` | `--force` | `{ file }` — writes a commented `default.yaml` template |
| `zm budget status` | `--month` | `{ month, monthElapsedPct, rows: [{ category, currency, planned, spent, spentOtherCurrencies, remaining, usedPct, monthElapsedPct, pace }], unplanned }` |
| `zm budget suggest` | `--months` (default 3), `--month` (default next month) | prints a draft yaml to stdout (not JSON, not written to a file) |

## Recipes

**Monthly review**
```
zm spend --by category --month 2026-09
zm compare --period 2026-09 --vs 2026-08 --by category
zm budget status
```

**Find subscriptions**
```
zm recurring --months 6
```
Looks for the same merchant + category recurring in at least 3 of the last 6
months.

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
(e.g. `Кафе` vs `Еда/Кафе`) makes `budget status` fail with an error, rather
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
| 5 | no local cache (run `zm sync`) |

On failure, stderr carries `{"error": {"code", "message", "hint"}}` (plain
text with `--format table`).
