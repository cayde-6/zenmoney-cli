// Orchestrates `zm edit`/`add`/`delete`: the only module in the write-mode
// feature that talks to the network (see docs/superpowers/specs/
// 2026-09-22-tx-write-mode-design.md's "Write flow"). A dry run just plans
// and prints; `--apply` syncs, re-plans against the post-sync cache, checks
// the caller's plan token still matches (retry/conflict detection), makes
// one POST, and applies the response to the cache. Everything that decides
// *what* to send lives in plan.ts/present.ts; this module only sequences the
// I/O around that pure planning.
import type { AppContext } from '../cli/context.js'
import { openCheckedStore, staleWarnings } from '../cli/program.js'
import type { Format } from '../cli/output.js'
import { printResult } from '../cli/output.js'
import { fetchDiff, parseTimeoutMs } from '../api/client.js'
import { requireToken } from '../auth/token.js'
import { loadDataset, type Dataset } from '../query/model.js'
import type { Store } from '../store/store.js'
import { ZmError } from '../errors.js'
import { isApplied, planToken, type PlannedChange } from './plan.js'
import { applyCommand, balanceImpact, changeViews, tableRows, type WriteData } from './present.js'

// Builds the plan from a Store; called once for dry-run (postSync: false),
// and once after the sync for --apply (postSync: true). Planners decide how
// a missing/deleted target is treated in each mode - this module just calls
// it and works with whatever PlannedChange rows come back.
export type Planner = (store: Store, ds: Dataset, o: { postSync: boolean }) => PlannedChange[]

export const RERUN_HINT = 'rerun without --apply to review the current state'

// Only a transport failure, an HTTP 5xx, or a malformed/unparseable
// response leave the write's outcome genuinely unknown - the POST may or
// may not have landed, so the safe move is retrying the exact same
// command. An HTTP 4xx means ZenMoney rejected the request outright before
// writing anything, so retrying the same --apply would just fail again;
// the hint instead points back at the plan.
const RETRY_HINT = 'the change may have been written; run the same command again, it is safe to retry'
const REJECTED_HINT = 'ZenMoney rejected the write; nothing was changed. Rerun without --apply to review the plan'

// Splits a plan into the changes that still need to happen and the ids of
// the ones that are already in their target state (a target already
// matching the request is dropped from what gets sent, never treated as
// blocking the rest - a multi-target edit where only some targets still
// need the change must still be applicable, not stuck in a permanent
// conflict loop against itself). Shared by the dry-run and --apply
// branches below, which both need to work with `pending` rather than the
// full plan from here on.
function splitPending(store: Store, changes: PlannedChange[]): { pending: PlannedChange[]; alreadyIds: string[] } {
  const pending: PlannedChange[] = []
  const alreadyIds: string[] = []
  for (const c of changes) {
    if (isApplied(c, store.getTransaction(c.id))) alreadyIds.push(c.id)
    else pending.push(c)
  }
  return { pending, alreadyIds }
}

export async function runWrite(ctx: AppContext, opts: {
  format: Format
  argv: string[] // args after `zm`, for applyCommand
  apply: boolean
  expect: string | undefined
  plan: Planner
}): Promise<void> {
  if (!opts.apply) {
    const store = openCheckedStore(ctx)
    try {
      const ds = loadDataset(store)
      const changes = opts.plan(store, ds, { postSync: false })
      const { pending, alreadyIds } = splitPending(store, changes)
      const token = planToken(pending)
      const { lastSyncAt } = store.getMeta()
      const warnings = [...staleWarnings(ctx, lastSyncAt)]
      if (pending.length === 0) {
        warnings.push('nothing to change: already in that state')
      } else if (alreadyIds.length > 0) {
        warnings.push(`already in that state: ${alreadyIds.join(', ')}`)
      }
      const data: WriteData = {
        applied: false,
        token,
        applyCommand: pending.length > 0 ? applyCommand(opts.argv, token) : null,
        changes: changeViews(ds, pending),
        balanceImpact: balanceImpact(ds, pending),
      }
      printResult(
        { data, meta: { lastSyncAt }, table: tableRows(pending), ...(warnings.length ? { warnings } : {}) },
        opts.format,
        ctx.stdout,
      )
    } finally {
      store.close()
    }
    return
  }

  // --apply. `--expect` is checked here too (the CLI layer also checks it)
  // so this module is safe to call directly, and before opening the store
  // so a missing token fails the same way with or without a cache.
  if (!opts.expect) {
    throw new ZmError(
      'INVALID_ARGS',
      '--apply requires --expect <token>',
      'run the command without --apply first and use the applyCommand it prints',
    )
  }

  const token = requireToken({ env: ctx.env, keychain: ctx.keychain, configFile: ctx.paths.configFile, platform: ctx.platform })
  const timeoutMs = parseTimeoutMs(ctx.env)
  const deps = { fetch: ctx.fetch, now: ctx.now, timeoutMs }

  const store = openCheckedStore(ctx)
  try {
    // Incremental sync first, applied to the cache, so the plan is
    // recomputed against the freshest known server state before anything is
    // sent - this is what catches a change already made in the app, by
    // another `zm` run, or by a `zm sync` between dry-run and apply.
    const syncDiff = await fetchDiff(token, store.getMeta().serverTimestamp, deps)
    store.applyDiff(syncDiff, ctx.now())

    const ds = loadDataset(store)
    const changes = opts.plan(store, ds, { postSync: true })
    const warnings = [...staleWarnings(ctx, store.getMeta().lastSyncAt)]

    const { pending } = splitPending(store, changes)

    if (pending.length === 0) {
      // Every target already matches the requested state - reported
      // against the full plan (there's nothing left "pending" to narrow it
      // to), no POST made.
      warnings.push('already applied')
      const data: WriteData = {
        applied: true,
        token: planToken(changes),
        applyCommand: null,
        changes: changeViews(ds, changes),
        balanceImpact: balanceImpact(ds, changes),
      }
      printResult({ data, meta: { lastSyncAt: store.getMeta().lastSyncAt }, table: tableRows(changes), warnings }, opts.format, ctx.stdout)
      return
    }

    // Reached with at least one target still pending (already-applied ones
    // were dropped above, never blocking the rest): a `create` among the
    // pending ones whose id already exists (with different content -
    // isApplied above already ruled out a matching one) is a genuine
    // conflict, not a retry.
    for (const c of pending) {
      if (c.op === 'create' && store.getTransaction(c.id) !== null) {
        throw new ZmError('CONFLICT', `transaction ${c.id} already exists with different content`, RERUN_HINT)
      }
    }

    if (planToken(pending) !== opts.expect) {
      throw new ZmError('CONFLICT', 'the data changed since the dry-run', RERUN_HINT)
    }

    const nowSec = Math.floor(ctx.now().getTime() / 1000)
    const payload = pending.map(c => {
      const changed = Math.max(nowSec, (c.base?.changed ?? 0) + 1)
      return { ...c.next, changed, ...(c.op === 'create' ? { created: changed } : {}) }
    })

    let response
    try {
      response = await fetchDiff(token, store.getMeta().serverTimestamp, deps, { transaction: payload })
    } catch (e) {
      if (e instanceof ZmError && e.code === 'NETWORK') {
        const hint = e.message.startsWith('ZenMoney API error 4') ? REJECTED_HINT : RETRY_HINT
        throw new ZmError('NETWORK', e.message, hint)
      }
      throw e
    }

    try {
      store.applyDiff(response, ctx.now())
    } catch {
      warnings.push('written to ZenMoney, but the local cache was not updated: run zm sync')
    }

    // Echo safety net: the response diff is expected to include every
    // transaction this POST just wrote, but that's a fact to verify rather
    // than trust outright (see the design spec's API facts) - flag any
    // pending change whose id the response doesn't echo back, rather than
    // silently assuming it landed exactly as sent. The payload itself is
    // never written into the cache directly; only what applyDiff above
    // actually applied from the response is.
    for (const c of pending) {
      if (!(response.transaction ?? []).some(t => t.id === c.id)) {
        warnings.push(`transaction ${c.id}: the server response did not echo this write; run zm sync --full to be sure the local cache matches ZenMoney`)
      }
    }

    // Balance safety net: the server maintains account.balance but a
    // transaction write's response may not always echo the updated account
    // (see the design spec's API facts) - flag it per account rather than
    // silently trusting a balance the response never actually confirmed.
    const impact = balanceImpact(ds, pending)
    for (const entry of impact) {
      if (!(response.account ?? []).some(a => a.id === entry.accountId)) {
        warnings.push(`account ${entry.accountTitle}: the server response did not include an updated balance; check it in ZenMoney`)
      }
    }

    const data: WriteData = {
      applied: true,
      token: planToken(pending),
      applyCommand: null,
      changes: changeViews(ds, pending),
      balanceImpact: impact,
    }
    printResult(
      { data, meta: { lastSyncAt: store.getMeta().lastSyncAt }, table: tableRows(pending), ...(warnings.length ? { warnings } : {}) },
      opts.format,
      ctx.stdout,
    )
  } finally {
    store.close()
  }
}
