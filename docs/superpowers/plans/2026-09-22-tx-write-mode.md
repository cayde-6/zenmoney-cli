# Transaction Write Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `zm edit`, `zm add`, `zm delete` — dry-run by default, writing to ZenMoney only with `--apply --expect <token>` from a dry-run.

**Architecture:** A pure planning layer (`src/write/plan.ts`) turns raw cached transactions + flags into a list of planned changes and a deterministic plan token. A presentation layer (`src/write/present.ts`) turns a plan into the output envelope. An orchestrator (`src/write/apply.ts`) runs sync → retry detection → token check → one `POST /v8/diff` → apply response to cache. Commander wiring lives in `src/cli/commands/write.ts`.

**Tech Stack:** TypeScript (ESM), commander 15, `node:sqlite`, `node:crypto`, vitest, tsup.

**Spec:** `docs/superpowers/specs/2026-09-22-tx-write-mode-design.md` — read it before any task.

## Global Constraints

- Node.js >= 22.13. No new runtime dependencies.
- Throw `ZmError` (`src/errors.ts`) for every command failure; never `cmd.error()`.
- Validate flag shape before opening the cache.
- Never add amounts across currencies; `balanceImpact` is per account and currency.
- Every result is a `{ data, meta, warnings? }` envelope printed with `printResult` (`src/cli/output.ts`); `meta.lastSyncAt` present.
- Tests use only `tests/fixtures/diff.ts` / synthetic data; build contexts with `testContext`/`seededContext` (`tests/helpers.ts`); network only through a mocked `ctx.fetch`.
- **No Cyrillic characters in any tracked file** (`tests/repo/no-cyrillic.test.ts`) and no NUL bytes (`tests/repo/no-nul.test.ts`).
- Coverage thresholds (lines 100, functions 100, statements 99, branches 98) must keep passing: `npm run verify` green at the end of every task.
- Never run `zm auth`, `zm sync`, or any `--apply` against the real API.
- All ZenMoney timestamps are Unix **seconds**.
- Implementers do **not** commit. The lead reviews `git diff`, then commits each task with the message given in its last step.

---

### Task 1: Foundations (no behaviour change)

**Files:**
- Modify: `src/errors.ts`
- Modify: `src/cli/context.ts` (add `uuid` to `AppContext` and `realContext`)
- Modify: `tests/helpers.ts` (default `uuid` in `testContext`)
- Modify: `src/store/store.ts` (add `getTransaction`)
- Modify: `src/api/client.ts` (`fetchDiff` optional push payload)
- Modify: `src/query/model.ts` (extract `toTx`, add `merchants` to `Dataset`)
- Modify: `src/query/filters.ts` (export `isValidDate`)
- Test: `tests/store/store.test.ts`, `tests/api/client.test.ts`, `tests/query/model.test.ts`, `tests/cli/context.test.ts`

**Interfaces — Produces:**
- `ErrorCode` gains `'CONFLICT'`, `EXIT.CONFLICT === 7`.
- `AppContext.uuid: () => string` (real: `crypto.randomUUID`; tests: counter-based `00000000-0000-4000-8000-00000000000N`).
- `Store#getTransaction(id: string): ZmTransaction | null` — raw row, including `deleted: true` rows.
- `fetchDiff(token, serverTimestamp, deps, push?: { transaction?: ZmTransaction[] }): Promise<ZmDiff>` — `push` fields are spread into the JSON body next to `currentClientTimestamp`/`serverTimestamp`.
- `interface TxLookups { accounts: Map<string, ZmAccount>; tags: Map<string, ZmTag>; instruments: Map<number, ZmInstrument>; merchants: Map<string, ZmMerchant>; ownerOf: Map<string, string> }`
- `toTx(t: ZmTransaction, l: TxLookups): Tx | null` — exactly the per-row body of today's `loadDataset` loop; returns `null` where the loop `continue`s (deleted, or income and outcome both 0).
- `Dataset` gains `merchants: Map<string, ZmMerchant>` (so a `Dataset` satisfies `TxLookups`).
- `export function isValidDate(s: string): boolean` in `src/query/filters.ts`.

- [ ] **Step 1: Write failing tests**

```ts
// tests/store/store.test.ts
it('getTransaction returns the raw row, deleted ones included, or null', () => {
  const s = fixtureStore()
  expect(s.getTransaction('t1')?.id).toBe('t1')
  const raw = { ...s.getTransaction('t1')!, deleted: true, changed: 1790000000 }
  s.applyDiff({ serverTimestamp: 1789000001, transaction: [raw] }, new Date())
  expect(s.getTransaction('t1')?.deleted).toBe(true)
  expect(s.getTransaction('nope')).toBeNull()
})

// tests/api/client.test.ts
it('fetchDiff sends push entities in the body', async () => {
  const calls: any[] = []
  const f = (async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ serverTimestamp: 5 }), { status: 200 }) }) as any
  const tx = { id: 'x' } as any
  await fetchDiff('tok', 4, { fetch: f, now: () => new Date(1000_000) }, { transaction: [tx] })
  expect(calls[0]).toEqual({ currentClientTimestamp: 1000, serverTimestamp: 4, transaction: [tx] })
})

// tests/query/model.test.ts
it('toTx matches loadDataset rows and is null for deleted / zero rows', () => {
  const s = fixtureStore()
  const ds = loadDataset(s)
  const raw = s.getTransaction('t1')!
  expect(toTx(raw, ds)).toEqual(ds.txs.find(t => t.id === 't1'))
  expect(toTx({ ...raw, deleted: true }, ds)).toBeNull()
  expect(toTx({ ...raw, income: 0, outcome: 0 }, ds)).toBeNull()
  expect(ds.merchants.get('m-fresh')?.title).toBe('FreshMart')
})

// tests/cli/context.test.ts
it('realContext.uuid returns a v4 uuid', () => {
  expect(realContext({ env: {} }).uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
```

Plus one assertion in an existing errors/program test that a `ZmError('CONFLICT', ...)` exits 7 (find the test that covers `EXIT` mapping in `tests/cli/program.test.ts` and add a case).

- [ ] **Step 2: Run tests, confirm they fail** — `npx vitest run tests/store tests/api tests/query/model.test.ts tests/cli/context.test.ts tests/cli/program.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/errors.ts
export type ErrorCode = 'UNEXPECTED' | 'INVALID_ARGS' | 'AUTH' | 'NETWORK' | 'NO_CACHE' | 'CACHE_BUSY' | 'CONFLICT'
export const EXIT: Record<ErrorCode, number> = { UNEXPECTED: 1, INVALID_ARGS: 2, AUTH: 3, NETWORK: 4, NO_CACHE: 5, CACHE_BUSY: 6, CONFLICT: 7 }

// src/store/store.ts (inside class Store, next to all())
getTransaction(id: string): ZmTransaction | null {
  return this.guard(() => {
    const row = this.db.prepare(`SELECT raw FROM "transaction" WHERE id = ?`).get(id) as { raw: string } | undefined
    return row ? JSON.parse(row.raw) as ZmTransaction : null
  })
}

// src/api/client.ts — signature + body only
export async function fetchDiff(
  token: string, serverTimestamp: number,
  deps: { fetch: typeof fetch; now: () => Date; timeoutMs?: number },
  push?: { transaction?: ZmTransaction[] },
): Promise<ZmDiff> {
  // ...
  body: JSON.stringify({ currentClientTimestamp: Math.floor(deps.now().getTime() / 1000), serverTimestamp, ...push }),
```

`src/query/model.ts`: move the body of the `for (const t of store.all('transaction'))` loop into `export function toTx(t, l: TxLookups): Tx | null` (replace `continue` with `return null`, `txs.push({...})` with `return {...}`, and read `accounts/tags/instruments/merchants/ownerOf` from `l`). `loadDataset` then does `const lookups = { accounts, tags, instruments, merchants, ownerOf }; for (const t of store.all('transaction')) { const tx = toTx(t, lookups); if (tx) txs.push(tx) }` and returns `merchants` in the `Dataset`. Keep every existing comment with the code it describes.

`src/cli/context.ts`: add `uuid: () => string` to `AppContext` with a one-line comment ("injected so tests get deterministic ids"), and `uuid: () => randomUUID()` in `realContext` (`import { randomUUID } from 'node:crypto'`). `tests/helpers.ts`: `let uuidN = 0` inside `testContext`, `uuid: () => \`00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}\``.

`src/query/filters.ts`: `export function isValidDate`.

- [ ] **Step 4: Run** `npm run verify` — all green, coverage thresholds pass.
- [ ] **Step 5: Commit** `refactor: foundations for write mode (CONFLICT code, toTx, getTransaction, fetchDiff push)`

---

### Task 2: Pure planning (`src/write/plan.ts`)

**Files:**
- Create: `src/write/plan.ts`
- Test: `tests/write/plan.test.ts`

**Interfaces:**
- Consumes: `Dataset`, `toTx` is NOT needed here; `ZmTransaction`, `ZmAccount` from `src/api/types.ts`; `classify` from `src/query/model.ts`; `ZmError`.
- Produces:

```ts
export type WriteOp = 'create' | 'update' | 'delete'
export interface PlannedChange {
  op: WriteOp
  id: string
  base: ZmTransaction | null        // cached raw before; null for create
  next: ZmTransaction               // raw to send (changed/created fixed later by apply); for delete: base with deleted: true
  set: Record<string, unknown>      // raw field -> new value; create: whole object minus changed/created; delete: {}
}
export interface EditFields { comment?: string; payee?: string; categoryId?: string; date?: string; amount?: number; accountId?: string }
export interface AddInput { id: string; kind: 'expense' | 'income'; amount: number; accountId: string; categoryId?: string; date: string; comment?: string; payee?: string }

export const UUID_RE: RegExp            // /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function parseAmount(raw: string, flag: string): number
export function isRestricted(t: ZmTransaction, ds: Dataset): boolean
export function planEdit(ds: Dataset, targets: ZmTransaction[], f: EditFields): PlannedChange[]
export function planAdd(ds: Dataset, input: AddInput): PlannedChange[]
export function planDelete(targets: ZmTransaction[]): PlannedChange[]
export function planToken(changes: PlannedChange[]): string
export function isApplied(c: PlannedChange, current: ZmTransaction | null): boolean
```

Rules (from the spec):
- `parseAmount`: `/^\d{1,12}(\.\d{1,2})?$/` and `> 0`, else `ZmError('INVALID_ARGS', \`invalid ${flag}: ${raw}\`, 'a positive number with at most 2 decimals, e.g. 33.88')`.
- `isRestricted(t, ds)`: `classify(t, ds.accounts, ds.tags)` is `transfer` or `debt`, OR `t.incomeInstrument !== t.outcomeInstrument`, OR any of `opIncome`, `opOutcome` is a non-zero number, OR any of `opIncomeInstrument`, `opOutcomeInstrument` is non-null. (When both `income` and `outcome` are 0, `classify` would misreport; treat such rows as not restricted by the classify rule — only the instrument/op rules apply.)
- `planEdit` builds `set`:
  - `comment`: `f.comment === '' ? null : f.comment`
  - `payee`: `''` → `{ payee: null }`; otherwise `{ payee: f.payee, merchant: null }`
  - `categoryId` → `{ tag: [id] }`
  - `date` → `{ date }`
  - `amount` → `{ outcome: amount }` if `base.outcome > 0` else `{ income: amount }`
  - `accountId` → `{ incomeAccount: id, outcomeAccount: id }`; if `ds.accounts.get(id).instrument !== base.outcomeInstrument` → `ZmError('INVALID_ARGS', 'target account has a different currency', ...)`
  - `amount`/`accountId` on any restricted target → one `ZmError('INVALID_ARGS', '--amount/--account cannot change a transfer, debt, or foreign-currency transaction', <ids>)` for the whole call.
  - `next = { ...base, ...set }`.
- `planAdd`: `next = { id, user: account.user, date, income: kind === 'income' ? amount : 0, outcome: kind === 'expense' ? amount : 0, incomeAccount: accountId, outcomeAccount: accountId, incomeInstrument: account.instrument, outcomeInstrument: account.instrument, tag: categoryId ? [categoryId] : null, merchant: null, payee: payee ?? null, comment: comment ?? null, hold: false, deleted: false, created: 0, changed: 0 }`; `set` = `next` minus `created`/`changed`. Account with `instrument === null` → `INVALID_ARGS`.
- `planDelete`: `next = { ...base, deleted: true }`, `set = {}`.
- `planToken`: `sha256(canonical(changes.map(c => ({ op, id, baseChanged: c.base?.changed ?? null, set: c.set })).sort(byId))).slice(0, 16)` where `canonical` is JSON with object keys sorted recursively.
- `isApplied`: update/create → `current !== null && !current.deleted && every key k of set: deepEqual(current[k], set[k])`; delete → `current === null || current.deleted === true`.

- [ ] **Step 1: Write failing tests** in `tests/write/plan.test.ts` using `fixtureStore()` + `loadDataset`. Cover at least:

```ts
const s = fixtureStore(); const ds = loadDataset(s); const t1 = s.getTransaction('t1')!

it('edit keeps unknown fields and only touches set', () => {
  const [c] = planEdit(ds, [{ ...t1, extraField: 42 } as any], { comment: 'Higgsfield' })
  expect(c.set).toEqual({ comment: 'Higgsfield' })
  expect((c.next as any).extraField).toBe(42)
  expect(c.next.outcome).toBe(t1.outcome)
})
it('payee clears merchant; empty payee does not', () => {
  expect(planEdit(ds, [t1], { payee: 'X' })[0].set).toEqual({ payee: 'X', merchant: null })
  expect(planEdit(ds, [t1], { payee: '' })[0].set).toEqual({ payee: null })
})
it('amount sets the outcome side of an expense', () => {
  expect(planEdit(ds, [t1], { amount: 12.5 })[0].set).toEqual({ outcome: 12.5 })
})
it('account sets both sides and rejects a different currency', () => {
  expect(planEdit(ds, [t1], { accountId: 'acc-partner' })[0].set).toEqual({ incomeAccount: 'acc-partner', outcomeAccount: 'acc-partner' })
  expect(() => planEdit(ds, [t1], { accountId: 'acc-eur' })).toThrow(/different currency/)
})
it('amount on a restricted tx fails the whole call', () => {
  const fx = { ...t1, id: 'fx', opOutcome: 5, opOutcomeInstrument: 1 }
  expect(() => planEdit(ds, [t1, fx], { amount: 1 })).toThrow(/transfer, debt, or foreign-currency/)
  expect(planEdit(ds, [fx], { comment: 'ok' })[0].set).toEqual({ comment: 'ok' })
})
it('parseAmount accepts 33.88, rejects 1e3, -1, 0, 1.234, " 5"', () => { /* ... */ })
it('token is deterministic, order-independent, and changes with base.changed and set', () => { /* ... */ })
it('isApplied for update/create/delete', () => { /* ... */ })
it('planAdd builds a full single-currency object', () => { /* expense on acc-pln: both instruments PLN, income 0 */ })
```

Find a transfer and a debt row in `tests/fixtures/diff.ts` (read the rest of the file) and add restricted-detection cases for both.

- [ ] **Step 2: Run, confirm failures** — `npx vitest run tests/write/plan.test.ts`
- [ ] **Step 3: Implement `src/write/plan.ts`** per the rules above. Use `createHash('sha256')` from `node:crypto`. Use `node:util`'s `isDeepStrictEqual` for `deepEqual`.
- [ ] **Step 4: Run** `npm run verify`.
- [ ] **Step 5: Commit** `feat(write): pure planning and plan token`

---

### Task 3: Presentation (`src/write/present.ts`)

**Files:**
- Create: `src/write/present.ts`
- Test: `tests/write/present.test.ts`

**Interfaces:**
- Consumes: `PlannedChange` (Task 2), `toTx`/`Tx`/`Dataset` (Task 1), `TableRow` from `src/cli/output.ts`.
- Produces:

```ts
export interface BalanceImpact { accountId: string; accountTitle: string; currency: string; delta: number }
export interface ChangeView { op: WriteOp; id: string; before: Tx | null; after: Tx | null; fields: string[]; raw?: ZmTransaction }
export interface WriteData { applied: boolean; token: string; applyCommand: string | null; changes: ChangeView[]; balanceImpact: BalanceImpact[] }

export function balanceImpact(ds: Dataset, changes: PlannedChange[]): BalanceImpact[]
export function changeViews(ds: Dataset, changes: PlannedChange[]): ChangeView[]
export function tableRows(changes: PlannedChange[]): TableRow[]
export function shellQuote(s: string): string
export function applyCommand(argv: string[], token: string): string
```

Rules:
- `balanceImpact`: contribution of a raw tx (skip if `deleted`): `+income` on `incomeAccount`, `-outcome` on `outcomeAccount`. `delta = contribution(next) - contribution(base)` summed per account id; round each delta to 2 decimals (`Math.round(x * 100) / 100`); drop zeros; `currency` = the account's instrument `shortTitle`; sort by `accountTitle`. One entry per account — each account has exactly one currency, so nothing is ever summed across currencies.
- `changeViews`: `before = base ? toTx(base, ds) : null`, `after = op === 'delete' ? null : toTx(next, ds)`, `fields = Object.keys(set).sort()`, `raw = base` only for `delete`.
- `tableRows`: per change, per field in `fields`: `{ id, op, field, before: fmt(base?.[field]), after: fmt(next[field]) }` where `fmt` is `null` for undefined/null, JSON for arrays/objects, else the value; delete → one row `{ id, op, field: '*', before: null, after: null }`.
- `shellQuote`: returns `s` unchanged if it matches `/^[A-Za-z0-9_\-.,:\/@=+]+$/`, else `'` + `s.replaceAll("'", "'\\''")` + `'`.
- `applyCommand(argv, token)`: `argv` is the user's args after `zm` (e.g. `['edit', 't1', '--comment', 'Higgs field']`). Drop any existing `--apply`, `--expect <v>`, `--expect=<v>`; return `['zm', ...argv, '--apply', '--expect', token].map(shellQuote).join(' ')` (`zm` itself unquoted).

- [ ] **Step 1: Failing tests** — at least: edit of t1 amount 3000→2500 gives `[{ accountId: 'acc-pln', currency: 'PLN', delta: 500 }]`; delete of t1 gives `+3000` on acc-pln; add income 10 on acc-eur gives `+10 EUR`; changing account moves the amount (two entries); views include `raw` only on delete; `income`→`refund` visible as `before.type !== after.type` when the category flips (pick an income tx in the fixture and set a tag with `showOutcome && !showIncome`, e.g. `food`); `shellQuote("it's")` === `'it'\''s'`; `applyCommand(['edit','t1','--comment','a b','--expect','old'], 'tok')` === `zm edit t1 --comment 'a b' --apply --expect tok`.
- [ ] **Step 2: Run, confirm failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm run verify`.
- [ ] **Step 5: Commit** `feat(write): output views, balance impact, apply command`

---

### Task 4: Apply orchestrator (`src/write/apply.ts`)

**Files:**
- Create: `src/write/apply.ts`
- Test: `tests/write/apply.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3; `requireToken` (`src/auth/token.ts`), `parseTimeoutMs`/`fetchDiff` (`src/api/client.ts`), `loadDataset`, `loadOwnersFile`/`ownersFilePath` as `withStore` users do (check how `src/cli/commands/reference.ts` loads the dataset and do the same), `staleWarnings`, `printResult`, `formatOf`.
- Produces:

```ts
// Builds the plan from a Store; called once for dry-run (postSync: false),
// and once after the sync for --apply (postSync: true).
export type Planner = (store: Store, ds: Dataset, o: { postSync: boolean }) => PlannedChange[]

export async function runWrite(ctx: AppContext, opts: {
  format: Format
  argv: string[]            // args after `zm`, for applyCommand
  apply: boolean
  expect: string | undefined
  plan: Planner
}): Promise<void>
```

Behaviour:
- **Dry-run** (`apply === false`): `openCheckedStore(ctx)`; `ds = loadDataset(...)`; `changes = plan(store, ds)`; `token = planToken(changes)`; warnings = stale warnings + `'nothing to change: already in that state'` if every change `isApplied(c, store.getTransaction(c.id))`. Print `{ data: { applied: false, token, applyCommand: applyCommand(argv, token), changes: changeViews, balanceImpact }, meta: { lastSyncAt }, warnings? }`, `table: tableRows(changes)`.
- **Apply**:
  1. `expect` missing → `ZmError('INVALID_ARGS', '--apply requires --expect <token>', 'run the command without --apply first and use the applyCommand it prints')` — thrown before opening the store (the CLI layer also checks, see Task 5; keep this as defence).
  2. `token = requireToken(...)` (same deps shape as `src/cli/commands/sync.ts`'s `tokenDeps`), `timeoutMs = parseTimeoutMs(ctx.env)`.
  3. Open the store with `openCheckedStore`; `diff = await fetchDiff(token, store.getMeta().serverTimestamp, deps)`; `store.applyDiff(diff, ctx.now())`.
  4. `ds = loadDataset(...)`, `changes = plan(store, ds, { postSync: true })`. (Dry-run calls `plan(store, ds, { postSync: false })`. How each planner treats missing/deleted targets in each mode is defined in Task 5.)
  5. `applied = changes.map(c => isApplied(c, store.getTransaction(c.id)))`. All true → print `applied: true`, `applyCommand: null`, warning `'already applied'`, no POST. Some true → `ZmError('CONFLICT', 'some of these changes are already applied and others are not', 'rerun without --apply to review the current state')`.
  6. For `create`: if `store.getTransaction(id)` exists (and step 5 said not applied) → `ZmError('CONFLICT', \`transaction ${id} already exists with different content\`, ...)`.
  7. `planToken(changes) !== expect` → `ZmError('CONFLICT', 'the data changed since the dry-run', 'rerun without --apply to review the current state')`.
  8. `nowSec = Math.floor(ctx.now().getTime() / 1000)`; payload = `changes.map(c => ({ ...c.next, changed: Math.max(nowSec, (c.base?.changed ?? 0) + 1), ...(c.op === 'create' ? { created: <same value as changed> } : {}) }))`.
  9. `try { response = await fetchDiff(token, store.getMeta().serverTimestamp, deps, { transaction: payload }) } catch (e) { if (e instanceof ZmError && e.code === 'NETWORK') throw new ZmError('NETWORK', e.message, 'the change may have been written; run the same command again, it is safe to retry'); throw e }`.
  10. `try { store.applyDiff(response, ctx.now()) } catch { warnings.push('written to ZenMoney, but the local cache was not updated: run zm sync') }`.
  11. Balance safety net: for each `balanceImpact` entry, if `!(response.account ?? []).some(a => a.id === entry.accountId)` → warning `\`account ${entry.accountTitle}: the server response did not include an updated balance; check it in ZenMoney\``.
  12. Print `applied: true`, `applyCommand: null`, same `changes`/`balanceImpact` as computed in step 4.
  - Always `store.close()` in `finally`.

- [ ] **Step 1: Failing tests** in `tests/write/apply.test.ts` with `seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, fetch })` and a recording fake fetch (copy the `apiFetch(bodies, calls)` helper from `tests/cli/sync.test.ts` into a new shared `tests/write/fakeApi.ts`). Planner under test: `(store, ds) => planEdit(ds, [store.getTransaction('t1')!], { comment: 'New' })`. Cases:
  - dry-run: no fetch call, `applied: false`, `applyCommand` contains `--expect <token>`.
  - apply success: calls = [sync body, push body]; push body has `serverTimestamp` equal to the sync response's; `transaction[0].comment === 'New'`; `changed === max(nowSec, 1780000000 + 1)`; cache now shows the response's version; output `applied: true`.
  - token mismatch: sync response contains t1 with a different `changed` → exit CONFLICT (7), only 1 fetch call.
  - already applied: sync response contains t1 already with `comment: 'New'` → exit 0, warning `already applied`, only 1 fetch call.
  - partial: two targets, one already applied → CONFLICT.
  - add with existing different id → CONFLICT.
  - delete: payload has `deleted: true`; delete of an id that the sync removed → already applied.
  - 401 on push → AUTH (3).
  - network failure on push → NETWORK (4) with the "safe to retry" hint.
  - cache write fails after push (make `applyDiff` throw on the second call via `vi.spyOn(Store.prototype, 'applyDiff')`) → exit 0, cache warning.
  - response without `account` → balance warning; with the account → no warning.
  Use `run(argv, ctx)` from `src/cli/program.ts` **only in Task 5**; here call `runWrite` directly and assert on `t.json()` / thrown `ZmError`.
- [ ] **Step 2: Run, confirm failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm run verify`.
- [ ] **Step 5: Commit** `feat(write): apply flow with sync, retry detection, and plan token check`

---

### Task 5: CLI wiring (`zm edit`, `zm add`, `zm delete`)

**Files:**
- Create: `src/cli/commands/write.ts`
- Modify: `src/cli/program.ts` (register; change description from `'Read-only ZenMoney CLI. ...'` to `'ZenMoney CLI: read-only analysis, plus dry-run-first writes (zm edit/add/delete). Agents: see SKILL.md in the package root.'`)
- Test: `tests/cli/write.test.ts`, `tests/e2e/bin.test.ts`

**Interfaces:**
- Consumes: `runWrite`, `planEdit`, `planAdd`, `planDelete`, `parseAmount`, `UUID_RE`, `isValidDate`, `resolveCategory`, `resolveAccount`, `formatOf`.
- Produces: `export function registerWrite(program: Command, ctx: AppContext): void`.

Commands:

```
zm edit <id...>  --comment <text> --payee <text> --category <query> --date <date> --amount <n> --account <query>  --apply --expect <token>
zm add           --expense <n> | --income <n>  --account <query> [--category] [--date] [--comment] [--payee] [--id <uuid>]  --apply --expect <token>
zm delete <id...> --apply --expect <token>
```

Each with `.addHelpText('after', ...)` examples in the same style as `zm tx` (synthetic names only, e.g. `zm edit t1 --comment Netflix`).

Validation **before opening the cache** (all `INVALID_ARGS`):
- `--owner` other than `all` (read via `cmd.optsWithGlobals().owner`).
- `--apply` without `--expect`; `add --apply` without `--id`; `--id` not matching `UUID_RE`.
- `edit` with no field flag; duplicate ids.
- `add`: neither or both of `--expense`/`--income`; missing `--account`.
- amounts via `parseAmount`; `--date` via `isValidDate`.

`argv` for `applyCommand`: commander does not expose raw argv per command; use `cmd.parent!.args` is not reliable — instead reconstruct from the parsed values in a fixed flag order: `[name, ...ids, ...flag pairs for every provided option, ('--id', id) for add]`. For `add` without `--id`, the dry-run uses `ctx.uuid()` and includes `--id <uuid>` in the reconstructed argv, so `applyCommand` carries it.

Planners (resolve category/account inside the planner, since they need the Dataset):
- edit: `(store, ds, { postSync }) =>` look up each id with `store.getTransaction`; missing or `deleted` → `INVALID_ARGS` listing them (dry-run) / `CONFLICT` "transaction was deleted or is gone" (postSync); then `planEdit`.
- add: `planAdd(ds, { id, ... })`.
- delete: missing → `INVALID_ARGS` (dry-run); postSync missing or deleted → keep a change built from a synthetic `{ id, deleted: true }` marker so `isApplied` reports it applied — simplest: in postSync, if missing, return `{ op: 'delete', id, base: null, next: { id } as ZmTransaction, set: {} }` (only ever used by `isApplied`, which returns true for `current === null`). Dry-run on an already-deleted target → `INVALID_ARGS` "already deleted".

- add, both modes: if `store.getTransaction(id)` exists and `isApplied` is false for it → `CONFLICT` "transaction <id> already exists with different content" (if `isApplied` is true, return the change as-is: dry-run then warns "nothing to change", apply reports "already applied").

- [ ] **Step 1: Failing tests** in `tests/cli/write.test.ts` through `run(['node','zm', ...args], t.ctx)`: every validation error above returns exit 2 **without opening the cache** (use `testContext()` with no cache — the error must still be `INVALID_ARGS`, not `NO_CACHE`); `zm edit t1 --comment X` dry-run JSON shape; `--format table` rows; `zm add --expense 10 --account "Card PLN"` dry-run shows `--id 00000000-0000-4000-8000-000000000001` in `applyCommand`; a full dry-run → apply round trip using the printed token with a fake fetch; `zm tx --month 2026-09` still works unchanged.
- [ ] **Step 2:** e2e in `tests/e2e/bin.test.ts`: built binary, seeded cache, `zm edit t1 --comment X` exits 0 with `applied: false`; `zm edit t1 --comment X --apply` exits 2. (Follow how that file already seeds a cache.)
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm run verify`; also `npm run build && node dist/bin.js edit --help` (paste nothing — just check it renders).
- [ ] **Step 5: Commit** `feat(cli): zm edit, zm add, zm delete`

---

### Task 6: Documentation

**Files:** `README.md`, `SKILL.md`, `docs/architecture.md`, `CLAUDE.md`, `CHANGELOG.md`

- [ ] **Step 1:** `npm run build` and capture `node dist/bin.js edit --help`, `add --help`, `delete --help`, `--help`; docs must match them exactly.
- [ ] **Step 2: README.md** — replace the "Read-only" bullet with "Dry-run first: `zm` only writes to ZenMoney with `--apply --expect <token>` from a dry-run you have seen; only transactions are ever written"; add a "Writing transactions" section (commands, plan token, retry safety, CONFLICT, restricted transactions); add exit code 7 wherever exit codes are listed.
- [ ] **Step 3: SKILL.md** — change the "never modified" rule to the new guarantee; add rows for `edit/add/delete` to the command table with the `data` shape; add the agent rule: "run `--apply` only when the user explicitly asked for that change and has seen the dry-run; always run the printed `applyCommand` verbatim; on exit 7 rerun the dry-run and show it again".
- [ ] **Step 4: docs/architecture.md** — new "Write flow" section: planning/presentation/apply split, plan token, retry detection, the unclosable sync→POST window, and the "API facts" list from the spec (with its sources).
- [ ] **Step 5: CLAUDE.md** — in "Never", extend the first bullet: "Run `zm auth`, `zm sync`, or any `zm edit/add/delete --apply` against the real ZenMoney API from an agent session". Do not add any exception.
- [ ] **Step 6: CHANGELOG.md** — under `[Unreleased]` → `Added`: the three commands, exit code 7; `Changed`: `zm` is no longer strictly read-only.
- [ ] **Step 7:** `npm run verify` (the no-Cyrillic test covers docs too).
- [ ] **Step 8: Commit** `docs: document write mode`
