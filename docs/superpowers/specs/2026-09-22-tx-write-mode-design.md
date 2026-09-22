# Transaction write mode (`zm edit` / `add` / `delete`) — design

Status: approved v3 (API facts resolved). Target release: 0.2.0
(minor).

## Goal

Let `zm` create, edit, and delete ZenMoney transactions, so a mistake found
while analysing spending (e.g. a mistyped comment) can be fixed from the CLI
instead of the ZenMoney app. This deliberately ends `zm`'s "read-only"
guarantee; the replacement guarantee is **"nothing is written unless you
pass back the plan token of a dry-run you have seen"**.

## Non-goals (v1)

- Creating transfers, debts, or foreign-currency transactions. Existing
  ones can still be edited (restricted fields, below) and deleted.
- Selecting targets by filter. `edit` and `delete` take explicit ids only;
  ids come from `zm tx ... | jq -r '.data[].id'`.
- Writing any entity other than transactions.
- A local undo/trash. The dry-run output contains the full raw copy of
  every transaction it deletes.
- A declarative change file. Can be layered on later.

## Terms

- **Single-currency simple transaction**: classified `expense`, `income`, or
  `refund` by `classify` (`src/query/model.ts`), with
  `incomeInstrument === outcomeInstrument` and none of `opIncome`,
  `opOutcome`, `opIncomeInstrument`, `opOutcomeInstrument` set (non-null,
  non-zero). Everything else — `transfer`, `debt`, or anything with `op*`
  set (a purchase in a foreign currency) — is **restricted**.
- **Target lookup** reads the raw `transaction` table directly, not
  `loadDataset`, so zero-amount rows are editable too. A target with
  `deleted: true` is "already deleted" (see retries).

## Commands

Top-level commands — not subcommands of `zm tx`: the `tx` command already
owns `--category`/`--account`/`--search`/`--type`/`--limit`, and commander
hands those to the parent (`enablePositionalOptions` would fix that but
break `--format`/`--owner` placed after a subcommand everywhere).

Common flags: `--apply`, `--expect <token>`, `--format json|table`.
`--owner` other than `all` exits 2. `--apply` without `--expect` exits 2.

### `zm edit <id...>`

Field flags (at least one, else exit 2):

| Flag | Allowed on | Effect on raw |
|---|---|---|
| `--comment <text>` | all | `comment`; `""` sets `null` |
| `--payee <text>` | all | `payee`; also sets `merchant: null`, since `merchantLabel` prefers a merchant and the new payee would otherwise be invisible. Shown in `fields`. `""` sets `payee: null` (merchant untouched). |
| `--category <query>` | all | `tag: [id]` via the existing category resolver. May turn income into refund or back (`classify`); visible as `before.type` vs `after.type`. |
| `--date YYYY-MM-DD` | all | `date` |
| `--amount <n>` | single-currency simple | the one non-zero side (`outcome` or `income`) |
| `--account <query>` | single-currency simple | both `incomeAccount` and `outcomeAccount` (they are equal on simple transactions); target account must have the same instrument, else exit 2 |

A restricted target with `--amount`/`--account` fails the whole command
(exit 2) — no partial edit.

### `zm add`

- Exactly one of `--expense <n>` / `--income <n>`.
- `--account <query>` required; instrument is the account's. Both account
  fields and both instrument fields are set to it; the non-used side is 0.
- Optional: `--category`, `--date` (default: today from `ctx.now()`'s
  *local* date components, not `toISOString`), `--comment`, `--payee`.
- `--id <uuid>`: dry-run without `--id` generates a UUID v4 and prints it
  inside the ready-to-run apply command; `--apply` requires `--id` (exit 2
  without it), so the command that is retried is always the same one.
- `user`: the account's `user`.

### `zm delete <id...>`

Explicit ids only.

### Input validation

- Amount: `^\d{1,12}(\.\d{1,2})?$`, must be > 0 (no `1e3`, no `0x`, no
  signs, no spaces — same spirit as `TIMEOUT_RE` in `src/api/client.ts`).
- Date: existing `YYYY-MM-DD` validator.
- Unknown id: exit 2 listing the unknown ids. Duplicate ids in one call:
  exit 2.
- All of this before opening the cache (repo rule).

## Plan token

The dry-run computes `token = first 16 hex chars of sha256(canonical JSON
of [{ op, id, baseChanged, set }])`, sorted by id, where `baseChanged` is
the target's cached `changed` (`null` for create) and `set` is the exact
raw-field assignments to be sent (for create: the whole new object minus
`changed`/`created`; for delete: `{}`).

The dry-run prints the exact apply command, e.g.
`zm edit 3b67… --comment Higgsfield --apply --expect 9f2c1a…`.

`--apply` recomputes the plan from the **post-sync** cache and compares
tokens. Mismatch → exit **CONFLICT (7)**, hint "rerun without --apply to
review the current state". This covers changes made in the app, by another
`zm` run, or by a `zm sync` between dry-run and apply.

## Output

`{ data, meta, warnings? }` envelope:

```
data: {
  applied: boolean,
  token: string,
  applyCommand: string | null,     // null when applied
  changes: [{ op, id, before: Tx|null, after: Tx|null, fields: string[], raw?: ZmTransaction }],
  balanceImpact: [{ accountId, accountTitle, currency, delta }]
}
```

- `fields`: the raw field names in `set` (create: every field set; delete:
  `[]`).
- `raw`: present on `delete` only — the full cached raw transaction, since a
  `Tx` row drops tags beyond the first, merchant id, `op*`, `user`,
  `created`.
- `balanceImpact`: per account and currency; never summed across
  currencies.
- `--format table`: one row per changed field (`id, op, field, before,
  after`); delete rows show `field: *`.

## Write flow

Dry-run: validate → open cache → look up targets → build new raw objects
by copying cached raw JSON and changing only `set` (unknown fields kept
verbatim) → compute token → print. No network.

`--apply`:
1. Validate; `--expect` and (for `add`) `--id` present.
2. Incremental sync via the existing sync path; apply to cache.
3. **Already-in-state filter** (both modes, per change): a change whose
   target already matches it (`isApplied`) is dropped from the plan before
   the token is computed.
   - edit: every field in `set` (except `merchant`, which the server may
     re-link) equals the planned value, with `null`/missing/`""` equal;
   - add: the id exists and its core fields (date, amounts, accounts,
     instruments, tag, payee, comment) match; exists but differs → CONFLICT;
   - delete: target is `deleted` or gone.
   Dry-run warns `already in that state: <ids>`. On `--apply`, nothing left
   → exit 0, `applied: true`, `warnings: ["already applied"]`, no POST —
   this is how a retry of a landed write is recognised.
4. Recompute the plan from the post-sync cache; token mismatch → CONFLICT.
5. One `POST /v8/diff` with the post-sync `serverTimestamp` and
   `currentClientTimestamp`, plus:
   - `transaction`: edited/created objects with
     `changed = max(nowSec, base.changed + 1)` (clock-skew guard); created
     get `created = changed`;
   - deleted ones as the cached raw with `deleted: true` (see API facts);
   `fetchDiff` is generalised to take an optional payload rather than a
   second HTTP function being written.
6. Apply the response diff to the cache with `applyDiff`, store its
   `serverTimestamp`, print `applied: true`.
   - If the POST succeeded but step 6 fails (CACHE_BUSY, SQLITE_FULL, …):
     still exit 0 with `applied: true` and `warnings: ["written to
     ZenMoney, but the local cache was not updated — run zm sync"]`.
7. Network failure during the POST (response unknown): exit NETWORK with
   hint "the change may have been written; run the same command again — it
   is safe to retry". Retrying the identical command hits step 3. `zm`
   never retries automatically.

The window between step 2 and step 5 (a change landing on the server in
between) cannot be closed with this protocol; it is documented, not
handled.

## API facts (resolved from docs, no live calls)

Sources: ZenPlugins wiki "ZenMoney-API" (Transaction schema, Diff object,
sync semantics); the open-source client zerro (github.com/ardov/zerro,
`src/5-entities/transaction/thunks.ts`, `src/6-shared/api/zenmoney/fetchDiff.ts`).

1. **Balances**: the server maintains `account.balance`; clients push only
   `transaction` objects (zerro never sends `account` on transaction
   writes). Confidence medium-high, so as a safety net: after `--apply`, if
   `balanceImpact` is non-zero for an account and the response diff contains
   no updated version of that account, add a warning ("account balance was
   not updated by the server; check it in ZenMoney").
2. **Deletion**: send the transaction with `deleted: true` in the
   `transaction` array (what zerro does). The `deletion` array is ZenMoney's
   permanent-removal path and is not used.
3. **Response**: symmetric to the request — a diff of everything changed
   since the sent `serverTimestamp` (our own writes included) plus a new
   `serverTimestamp`. Conflicts resolve server-side by `changed`
   (last-write-wins), hence the skew guard. All timestamps are Unix
   seconds.
4. **Required Transaction fields**: `id, changed, created, user, deleted,
   incomeInstrument, incomeAccount, income, outcomeInstrument,
   outcomeAccount, outcome, date`. A created transaction sets exactly these
   plus the optional ones the user passed (`tag`, `payee`, `comment`), with
   `merchant: null`, `hold: false`.

These are recorded in `docs/architecture.md` as part of the implementation.

## Errors

| Situation | Code |
|---|---|
| bad/missing flags, `--apply` without `--expect`, `add --apply` without `--id`, bad amount/date, restricted field on restricted tx, cross-instrument `--account`, unknown/duplicate id, `--owner` ≠ all | INVALID_ARGS (2) |
| no token / token rejected | AUTH (3) |
| unreachable, timeout, 5xx (token scrubbed as today) | NETWORK (4) |
| no cache | NO_CACHE (5) |
| cache busy before the POST | CACHE_BUSY (6) |
| token mismatch (incl. a partially landed batch), `add` id exists with different content | CONFLICT (7) — new |

## Agent rules

- SKILL.md: agents may run `--apply` only when the user explicitly asked
  for that change and was shown the dry-run first; always use the printed
  `applyCommand` verbatim.
- CLAUDE.md is **not** loosened: it governs agents working on this
  repository, where live calls stay forbidden. Add `--apply` to its
  "Never" list next to `zm auth`/`zm sync`.

## Testing

- Unit: patch building (unknown fields kept, `payee` clears `merchant`,
  both account/instrument fields on `--account`, restricted detection incl.
  `op*`), token determinism and sensitivity, amount/date validation,
  per-currency `balanceImpact`, income↔refund reclassification shown.
- `--apply` with mocked `fetch`: success; CONFLICT on token mismatch;
  already-applied (edit/add/delete), a target already in state before the
  dry-run; 401; network error;
  POST ok but cache write fails → exit 0 + warning; request body
  (`serverTimestamp`, `changed` skew guard, `deleted: true`); missing
  account update in the response → balance warning.
- e2e (built binary): dry-run over the synthetic fixture, no network;
  `--apply` without `--expect` exits 2.
- Synthetic data only. Coverage thresholds unchanged.

## Docs

README (drop "Read-only", new commands, plan token), SKILL.md (rule +
table), `docs/architecture.md` (write flow, token, CONFLICT, answers to the
API facts), CLAUDE.md ("Never" list), CHANGELOG `[Unreleased]`, exit
code 7 wherever exit codes are listed.
