# Transaction write mode (`zm tx edit` / `add` / `delete`) — design

Status: draft, awaiting review. Target release: 0.2.0 (minor).

## Goal

Let `zm` create, edit, and delete ZenMoney transactions, so a mistake found
while analysing spending (e.g. a mistyped comment) can be fixed from the CLI
instead of the ZenMoney app. This deliberately ends `zm`'s "read-only"
guarantee; the replacement guarantee is **"nothing is written without
`--apply`"**.

## Non-goals (v1)

- Creating transfers, debts, or multi-currency transactions (two sides and
  an exchange rate — a separate feature). They can still be edited (fields
  listed below) and deleted.
- Writing any entity other than transactions (and, if required by the
  balance question below, accounts' `balance`): no categories, merchants,
  accounts, or ZenMoney-side budgets.
- A local undo/trash. Deletion is ZenMoney's own deletion; the dry-run
  output contains the full `before` copy of every deleted transaction.
- A declarative change file (`zm apply changes.yaml`). Can be layered on
  top of these commands later.

## Commands

All three are subcommands of `zm tx`. `zm tx [filters]` without a
subcommand keeps its current behaviour.

Common flags: `--apply` (without it: dry-run), `--format json|table`.
`--owner` is rejected with any value other than `all` (exit 2) — writes have
no owner semantics.

### `zm tx edit [id...]`

Selection — exactly one of:
- one or more transaction ids as positional arguments;
- the `zm tx` filters: `--from/--to/--month`, `--category`, `--account`,
  `--currency`, `--type`, `--search`.

Mixing ids and filters, or giving neither, exits 2. With filters, if more
than `--max <n>` (default 10) transactions match, exit 2 with the match
count in the message; raise `--max` explicitly to go further. Zero matches
is not an error: `applied: false`, empty `changes`, and a `warnings` entry.

Field flags (at least one required, else exit 2):

| Flag | Allowed on | Notes |
|---|---|---|
| `--comment <text>` | all types | `""` clears |
| `--payee <text>` | all types | `""` clears |
| `--category <query>` | all types | same resolver as the filter; replaces `tag` with `[id]` |
| `--date YYYY-MM-DD` | all types | |
| `--amount <n>` | expense, income, refund | positive decimal; sets the one non-zero side |
| `--account <query>` | expense, income, refund | target account must have the same currency |

`--amount`/`--account` on a transfer, debt, or multi-currency transaction
exits 2, and the whole command fails (no partial edit of a mixed
selection).

Note the ambiguity: `--category`, `--account` are both filters and field
flags. Resolution: in `edit`, filters use the `--where-` prefix
(`--where-category`, `--where-account`, `--where-currency`,
`--where-type`, `--where-search`, `--where-from/--where-to/--where-month`);
the unprefixed names are always field setters. This keeps each flag with a
single meaning.

### `zm tx add`

- Exactly one of `--expense <n>` / `--income <n>` (positive decimal).
- `--account <query>` required; currency is the account's.
- Optional: `--category <query>`, `--date` (default: today, local time),
  `--comment`, `--payee`.
- New id: a client-generated UUID v4, printed in the dry-run and reused by
  `--apply` only if the caller passes it back via `--id <uuid>` (so that a
  retry after a network failure is idempotent). Without `--id`, `--apply`
  generates a fresh one.

### `zm tx delete <id...>`

Explicit ids only; no filters, by design.

## Output

Every write command prints the usual `{ data, meta, warnings? }` envelope:

```
data: {
  applied: boolean,
  changes: [{ op: "create"|"update"|"delete", id, before|null, after|null, fields: string[] }],
  balanceImpact: [{ accountId, accountTitle, currency, delta }]
}
```

`before`/`after` are `Tx` rows in the same shape as `zm tx`. `balanceImpact`
is per account and per currency — never summed across currencies.
`--format table` renders one row per changed field (`id, op, field, before,
after`).

## Write flow

Dry-run:
1. Validate every flag before opening the cache.
2. Load targets from the cache; build each new raw transaction by copying
   the cached raw JSON and changing only the requested fields (unknown
   fields preserved verbatim).
3. Print the envelope with `applied: false`. No network.

`--apply`:
1. Steps 1–2 as above; remember each target's cached `changed`.
2. Run an incremental sync (same code path as `zm sync`) and apply it to
   the cache.
3. Re-read targets. If any target is gone, deleted, or its `changed`
   differs from step 1, exit **CONFLICT (7)** — hint: rerun without
   `--apply` to see the current state. Nothing is sent.
4. Rebuild the patch from the post-sync state and send it in **one**
   `POST /v8/diff`:
   - `transaction`: edited and created transactions, `changed = now`
     (seconds); created ones also get `created = now` and `user` = the
     target account's `user`;
   - `deletion`: `{ id, object: "transaction", stamp: now, user }`;
   - `account`: only if the balance question below resolves to "client
     sends balances".
5. Apply the server's response diff to the cache (same `applyDiff`), store
   its `serverTimestamp`, print `applied: true`.

Network failure after the request may have been sent: exit NETWORK with the
hint "run zm sync, then check with zm tx". `zm` never retries by itself.

## Open question to resolve first: account balances

It is not yet verified whether the ZenMoney server recomputes
`account.balance` after transaction writes, or whether clients are expected
to send updated accounts alongside. The first implementation step is to
settle this from the ZenMoney API documentation (ZenPlugins wiki) and the
behaviour of the open-source clients — **without calling the live API**.
If clients send balances, `balanceImpact` is also applied to the affected
accounts and sent in the same POST. The result is recorded in
`docs/architecture.md`.

## Errors

| Situation | Code |
|---|---|
| bad/missing selector or field flags, `--expense`+`--income`, bad date/amount, `--amount`/`--account` on transfer/debt/multi-currency, cross-currency `--account`, over `--max`, unknown/ambiguous id | INVALID_ARGS (2) |
| no token, token rejected | AUTH (3) |
| unreachable, timeout, 5xx (token scrubbed as today) | NETWORK (4) |
| no cache | NO_CACHE (5) |
| cache busy | CACHE_BUSY (6) |
| target changed/deleted on the server since the last sync | CONFLICT (7) — new |

## Agent rules

- SKILL.md: agents may run `--apply` only when the user explicitly asked
  for that change and was shown the dry-run output first.
- CLAUDE.md: the "never make live network calls" rule gains the same
  exception for `zm tx ... --apply`; `zm auth` stays forbidden.

## Testing

- Unit: patch building (unknown fields preserved, per-currency
  `balanceImpact`, refusals for transfers/multi-currency, `--max`, id vs
  filter selection).
- `--apply` flow with a mocked `fetch`: success, CONFLICT, 401, network
  failure, idempotent `add --id` retry; assert the POST body and that the
  cache reflects the response.
- e2e (built binary): dry-run over the synthetic fixture, no network.
- Only `tests/fixtures/diff.ts` / synthetic data. Coverage thresholds
  unchanged.

## Docs

README (drop "Read-only", command reference), SKILL.md (rule + table),
`docs/architecture.md` (write flow, CONFLICT, balance decision), CLAUDE.md
(exception), CHANGELOG `[Unreleased]`, new exit code 7 everywhere exit
codes are listed.
