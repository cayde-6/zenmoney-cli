import { it, expect } from 'vitest'
import { run } from '../../src/cli/program.js'
import { seededContext, testContext } from '../helpers.js'
import { fixtureDiff } from '../fixtures/diff.js'
import { Store } from '../../src/store/store.js'
import { apiFetch } from '../write/fakeApi.js'

const zm = async (args: string[], over = {}) => { const t = seededContext(over); const code = await run(['node', 'zm', ...args], t.ctx); return { code, t } }

// Splits a command string produced by src/write/present.ts's applyCommand
// back into argv, understanding exactly its own quoting rules: a token is
// either a bare word, or wrapped in single quotes with the POSIX '\'' idiom
// (close quote, backslash-escaped literal quote, reopen quote) used to embed
// a literal single quote. Not a general shell parser -- only shellQuote's
// own output shape.
function splitApplyCommand(cmd: string): string[] {
  const tokens: string[] = []
  let i = 0
  const n = cmd.length
  while (i < n) {
    while (i < n && cmd[i] === ' ') i++
    if (i >= n) break
    let token = ''
    while (i < n && cmd[i] !== ' ') {
      const c = cmd[i]
      if (c === "'") {
        i++
        while (i < n && cmd[i] !== "'") { token += cmd[i]; i++ }
        i++ // skip closing quote
      } else if (c === '\\') {
        i++
        if (i < n) { token += cmd[i]; i++ }
      } else {
        token += c
        i++
      }
    }
    tokens.push(token)
  }
  return tokens
}

// --- Validation before the cache is opened: every one of these must use a
// context with NO cache at all, and still fail as INVALID_ARGS (not
// NO_CACHE) -- proof the check runs before openCheckedStore.
const noCache = () => testContext({ env: { ZENMONEY_TOKEN: 'tok' } })

it('--owner other than all is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'edit', 't1', '--comment', 'X', '--owner', 'me'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
  expect(t.errJson().error.message).toBe('--owner is not supported by edit')
})

it('add --owner other than all is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'add', '--expense', '10', '--account', 'a', '--owner', 'me'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error.message).toBe('--owner is not supported by add')
})

it('delete --owner other than all is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'delete', 't1', '--owner', 'me'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error.message).toBe('--owner is not supported by delete')
})

it('--apply without --expect is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'edit', 't1', '--comment', 'X', '--apply'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--apply requires --expect <token>' })
})

it('delete --apply without --expect is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'delete', 't1', '--apply'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
})

it('add --apply without --id is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'add', '--expense', '10', '--account', 'a', '--apply', '--expect', 'deadbeefdeadbeef'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--apply requires --id <uuid>' })
})

it('add --id not matching UUID_RE is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'add', '--expense', '10', '--account', 'a', '--id', 'not-a-uuid'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'invalid --id: not-a-uuid' })
})

it('add --id is lowercased before validating/using it', async () => {
  const upper = '3B67E2C0-1234-4ABC-9DEF-1234567890AB'
  const { code, t } = await zm(['add', '--expense', '10', '--account', 'Card PLN', '--id', upper])
  expect(code).toBe(0)
  const { data } = t.json()
  expect(data.applyCommand).toContain(upper.toLowerCase())
  expect(data.applyCommand).not.toContain(upper)
})

it('edit with no field flag is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'edit', 't1'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'edit needs at least one field flag' })
})

it('edit with duplicate ids is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'edit', 't1', 't1', '--comment', 'X'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'duplicate transaction id: t1' })
})

it('delete with duplicate ids is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'delete', 't1', 't2', 't1'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'duplicate transaction id: t1' })
})

it('add with neither --expense nor --income is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'add', '--account', 'a'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'add needs exactly one of --expense or --income' })
})

it('add with both --expense and --income is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'add', '--expense', '10', '--income', '10', '--account', 'a'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'add needs exactly one of --expense or --income' })
})

it('add with no --account is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'add', '--expense', '10'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--account is required' })
})

it('edit --amount with a bad value is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'edit', 't1', '--amount', '1e3'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'invalid --amount: 1e3' })
})

it('add --expense with a bad value is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'add', '--expense', '0', '--account', 'a'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'invalid --expense: 0' })
})

it('edit --date with a bad value is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'edit', 't1', '--date', '2026-13-40'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'invalid --date: 2026-13-40' })
})

it('add --date with a bad value is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'add', '--expense', '10', '--account', 'a', '--date', 'not-a-date'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'invalid --date: not-a-date' })
})

it('edit --category "" is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'edit', 't1', '--category', ''], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--category must not be empty' })
})

it('edit --account "" is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'edit', 't1', '--account', ''], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--account must not be empty' })
})

it('add --category "" is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'add', '--expense', '10', '--account', 'a', '--category', ''], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--category must not be empty' })
})

it('add --account "" is rejected before the cache is opened', async () => {
  const t = noCache()
  const code = await run(['node', 'zm', 'add', '--expense', '10', '--account', ''], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--account must not be empty' })
})

// --- Dry-run functional behaviour (seeded cache) ---

it('zm edit t1 --comment X dry-run JSON shape', async () => {
  const { code, t } = await zm(['edit', 't1', '--comment', 'New comment'])
  expect(code).toBe(0)
  const { data } = t.json()
  expect(data.applied).toBe(false)
  expect(data.token).toMatch(/^[0-9a-f]{16}$/)
  expect(data.applyCommand).toBe(`zm edit t1 --comment 'New comment' --apply --expect ${data.token}`)
  expect(data.changes).toHaveLength(1)
  expect(data.changes[0]).toMatchObject({ op: 'update', id: 't1', fields: ['comment'] })
  expect(data.changes[0].before.comment).toBeNull()
  expect(data.changes[0].after.comment).toBe('New comment')
})

it('--format table renders one row per changed field', async () => {
  const { code, t } = await zm(['edit', 't1', '--comment', 'New comment', '--format', 'table'])
  expect(code).toBe(0)
  const out = t.out.join('')
  expect(out).toMatch(/id\s+op\s+field\s+before\s+after/)
  expect(out).toMatch(/t1\s+update\s+comment/)
})

it('zm add dry-run shows the generated --id in applyCommand', async () => {
  const { code, t } = await zm(['add', '--expense', '10', '--account', 'Card PLN'])
  expect(code).toBe(0)
  const { data } = t.json()
  expect(data.applyCommand).toContain('--id 00000000-0000-4000-8000-000000000001')
  expect(data.applyCommand).toMatch(/^zm add --expense 10 --account 'Card PLN' --date 2026-09-15 --id/)
})

it('zm edit --category resolves a category query and reports the reclassification', async () => {
  const { code, t } = await zm(['edit', 't1', '--category', 'Health'])
  expect(code).toBe(0)
  const { data } = t.json()
  expect(data.applyCommand).toBe(`zm edit t1 --category Health --apply --expect ${data.token}`)
  expect(data.changes[0].fields).toEqual(['tag'])
})

it('zm edit --date sets a new date', async () => {
  const { code, t } = await zm(['edit', 't1', '--date', '2026-09-20'])
  expect(code).toBe(0)
  const { data } = t.json()
  expect(data.applyCommand).toBe(`zm edit t1 --date 2026-09-20 --apply --expect ${data.token}`)
  expect(data.changes[0].after.date).toBe('2026-09-20')
})

it('zm edit --amount changes the amount on a single-currency simple transaction', async () => {
  const { code, t } = await zm(['edit', 't1', '--amount', '35.50'])
  expect(code).toBe(0)
  const { data } = t.json()
  expect(data.applyCommand).toBe(`zm edit t1 --amount 35.50 --apply --expect ${data.token}`)
  expect(data.changes[0].after.amount).toBe(35.5)
})

it('zm edit --account moves a transaction to a different same-currency account', async () => {
  const { code, t } = await zm(['edit', 't1', '--account', 'Card Partner'])
  expect(code).toBe(0)
  const { data } = t.json()
  expect(data.applyCommand).toBe(`zm edit t1 --account 'Card Partner' --apply --expect ${data.token}`)
  expect(data.changes[0].after.accountId).toBe('acc-partner')
})

it('zm add --category resolves a category query', async () => {
  const { code, t } = await zm(['add', '--expense', '10', '--account', 'Card PLN', '--category', 'Groceries'])
  expect(code).toBe(0)
  const { data } = t.json()
  expect(data.applyCommand).toMatch(/--category Groceries/)
  expect(data.changes[0].after.categoryPath).toBe('Groceries')
})

it('zm add --income adds an income transaction', async () => {
  const { code, t } = await zm(['add', '--income', '500', '--account', 'Card PLN'])
  expect(code).toBe(0)
  const { data } = t.json()
  expect(data.applyCommand).toMatch(/^zm add --income 500 --account 'Card PLN'/)
  expect(data.changes[0].after.type).toBe('income')
})

it('zm add --format table shows a create row', async () => {
  const { code, t } = await zm(['add', '--expense', '10', '--account', 'Card PLN', '--format', 'table'])
  expect(code).toBe(0)
  const out = t.out.join('')
  expect(out).toMatch(/create/)
})

it('zm delete --format table shows a delete row', async () => {
  const { code, t } = await zm(['delete', 't1', '--format', 'table'])
  expect(code).toBe(0)
  const out = t.out.join('')
  expect(out).toMatch(/delete\s+\*/)
})

it('zm tx --month 2026-09 still works unchanged', async () => {
  const { code, t } = await zm(['tx', '--month', '2026-09'])
  expect(code).toBe(0)
  expect(Array.isArray(t.json().data)).toBe(true)
})

// --- Full dry-run -> apply round trips, with a fake fetch ---

it('edit: full dry-run -> apply round trip using the printed token', async () => {
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  const dryCode = await run(['node', 'zm', 'edit', 't1', '--comment', 'New comment'], t.ctx)
  expect(dryCode).toBe(0)
  const token = t.json().data.token
  t.out.length = 0

  const calls: any[] = []
  const preSyncStore = Store.open(t.ctx.paths.cacheDb)
  const cachedT1 = preSyncStore.getTransaction('t1')!
  preSyncStore.close()
  ;(t.ctx as any).fetch = apiFetch([fixtureDiff(), { serverTimestamp: 1789000200, transaction: [{ ...cachedT1, comment: 'New comment', changed: 1789000200 }] }], calls)

  const applyCode = await run(['node', 'zm', 'edit', 't1', '--comment', 'New comment', '--apply', '--expect', token], t.ctx)
  expect(applyCode).toBe(0)
  const out = t.json()
  expect(out.data.applied).toBe(true)
  expect(out.data.applyCommand).toBeNull()
  expect(calls).toHaveLength(2)
  expect(calls[1].transaction[0]).toMatchObject({ id: 't1', comment: 'New comment' })
})

it('add: full dry-run -> apply round trip using the printed id and token', async () => {
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  const dryCode = await run(['node', 'zm', 'add', '--expense', '12.50', '--account', 'Card PLN'], t.ctx)
  expect(dryCode).toBe(0)
  const dry = t.json()
  const token = dry.data.token
  const idMatch = /--id (\S+)/.exec(dry.data.applyCommand)!
  const id = idMatch[1]!
  t.out.length = 0

  const calls: any[] = []
  const pushedTx = {
    id, user: 10, date: '2026-09-15', income: 0, outcome: 12.5,
    incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln', incomeInstrument: 100, outcomeInstrument: 100,
    tag: null, merchant: null, payee: null, comment: null, deleted: false, created: 1789000200, changed: 1789000200,
  }
  ;(t.ctx as any).fetch = apiFetch([fixtureDiff(), { serverTimestamp: 1789000200, transaction: [pushedTx] }], calls)

  const applyCode = await run(['node', 'zm', 'add', '--expense', '12.50', '--account', 'Card PLN', '--id', id, '--apply', '--expect', token], t.ctx)
  expect(applyCode).toBe(0)
  const out = t.json()
  expect(out.data.applied).toBe(true)
  expect(calls[1].transaction[0]).toMatchObject({ id, outcome: 12.5 })
})

it('delete: full dry-run -> apply round trip using the printed token', async () => {
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  const dryCode = await run(['node', 'zm', 'delete', 't1'], t.ctx)
  expect(dryCode).toBe(0)
  const token = t.json().data.token
  t.out.length = 0

  const calls: any[] = []
  const preSyncStore = Store.open(t.ctx.paths.cacheDb)
  const originalT1 = preSyncStore.getTransaction('t1')!
  preSyncStore.close()
  ;(t.ctx as any).fetch = apiFetch([fixtureDiff(), { serverTimestamp: 1789000200, transaction: [{ ...originalT1, deleted: true, changed: 1789000200 }] }], calls)

  const applyCode = await run(['node', 'zm', 'delete', 't1', '--apply', '--expect', token], t.ctx)
  expect(applyCode).toBe(0)
  const out = t.json()
  expect(out.data.applied).toBe(true)
  expect(calls[1].transaction[0]).toMatchObject({ id: 't1', deleted: true })
})

// --- Round trips driven by the printed applyCommand itself, not by
// hand-assembled argv: proof that the exact text a caller would copy-paste
// (with its shell quoting) really does reproduce the dry-run's plan. ---

it('edit: round trip via argv parsed back out of applyCommand', async () => {
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  const dryCode = await run(['node', 'zm', 'edit', 't3', '--payee', 'New Payee'], t.ctx)
  expect(dryCode).toBe(0)
  const dry = t.json()
  expect(dry.data.applyCommand).toBe(`zm edit t3 --payee 'New Payee' --apply --expect ${dry.data.token}`)
  t.out.length = 0

  const calls: any[] = []
  const preSyncStore = Store.open(t.ctx.paths.cacheDb)
  const cachedT3 = preSyncStore.getTransaction('t3')!
  preSyncStore.close()
  ;(t.ctx as any).fetch = apiFetch(
    [fixtureDiff(), { serverTimestamp: 1789000200, transaction: [{ ...cachedT3, payee: 'New Payee', merchant: null, changed: 1789000200 }] }],
    calls,
  )

  const argv = splitApplyCommand(dry.data.applyCommand).slice(1) // drop the leading 'zm'
  const applyCode = await run(['node', 'zm', ...argv], t.ctx)
  expect(applyCode).toBe(0)
  expect(t.json().data.applied).toBe(true)
  expect(calls[1].transaction[0]).toMatchObject({ id: 't3', payee: 'New Payee' })
})

it('add: round trip via argv parsed back out of applyCommand, keeping the dry-run\'s date across a local midnight', async () => {
  let current = new Date('2026-09-15T23:50:00')
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' }, now: () => current })
  const dryCode = await run(['node', 'zm', 'add', '--expense', '9.99', '--account', 'Card PLN'], t.ctx)
  expect(dryCode).toBe(0)
  const dry = t.json()
  expect(dry.data.applyCommand).toMatch(/--date 2026-09-15\b/)
  const id = /--id (\S+)/.exec(dry.data.applyCommand)![1]!
  t.out.length = 0

  current = new Date('2026-09-16T00:10:00') // past local midnight, before --apply runs

  const calls: any[] = []
  const pushedTx = {
    id, user: 10, date: '2026-09-15', income: 0, outcome: 9.99,
    incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln', incomeInstrument: 100, outcomeInstrument: 100,
    tag: null, merchant: null, payee: null, comment: null, deleted: false, created: 1789000200, changed: 1789000200,
  }
  ;(t.ctx as any).fetch = apiFetch([fixtureDiff(), { serverTimestamp: 1789000200, transaction: [pushedTx] }], calls)

  const argv = splitApplyCommand(dry.data.applyCommand).slice(1)
  const applyCode = await run(['node', 'zm', ...argv], t.ctx)
  expect(applyCode).toBe(0)
  expect(t.json().data.applied).toBe(true)
  // The POST carries the dry-run's date (2026-09-15), not the apply-time
  // local date (2026-09-16) -- the argv parsed out of applyCommand pins it.
  expect(calls[1].transaction[0]).toMatchObject({ id, date: '2026-09-15' })
})

it('delete: round trip via argv parsed back out of applyCommand', async () => {
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  const dryCode = await run(['node', 'zm', 'delete', 't1'], t.ctx)
  expect(dryCode).toBe(0)
  const dry = t.json()
  t.out.length = 0

  const calls: any[] = []
  const preSyncStore = Store.open(t.ctx.paths.cacheDb)
  const originalT1 = preSyncStore.getTransaction('t1')!
  preSyncStore.close()
  ;(t.ctx as any).fetch = apiFetch([fixtureDiff(), { serverTimestamp: 1789000200, transaction: [{ ...originalT1, deleted: true, changed: 1789000200 }] }], calls)

  const argv = splitApplyCommand(dry.data.applyCommand).slice(1)
  const applyCode = await run(['node', 'zm', ...argv], t.ctx)
  expect(applyCode).toBe(0)
  expect(t.json().data.applied).toBe(true)
  expect(calls[1].transaction[0]).toMatchObject({ id: 't1', deleted: true })
})

// --- edit: unknown/deleted targets ---

it('edit an unknown id: INVALID_ARGS listing it, dry-run', async () => {
  const { code, t } = await zm(['edit', 'nope', '--comment', 'X'])
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'unknown transaction id: nope' })
})

it('edit a present-but-already-deleted id: INVALID_ARGS "already deleted", dry-run', async () => {
  const { code, t } = await zm(['edit', 't9', '--comment', 'X']) // t9 is deleted in the fixture
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'already deleted: t9' })
})

it('edit with both an unknown id and a deleted id reports the unknown one first', async () => {
  const { code, t } = await zm(['edit', 'nope', 't9', '--comment', 'X'])
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'unknown transaction id: nope' })
})

it('edit: target deleted between dry-run and --apply exits CONFLICT', async () => {
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  const dryCode = await run(['node', 'zm', 'edit', 't1', '--comment', 'New comment'], t.ctx)
  expect(dryCode).toBe(0)
  const token = t.json().data.token
  t.out.length = 0

  const calls: any[] = []
  const syncResponse = { serverTimestamp: 1789000200, deletion: [{ id: 't1', object: 'transaction', stamp: 1789000100, user: 10 }] }
  ;(t.ctx as any).fetch = apiFetch([syncResponse], calls)

  const applyCode = await run(['node', 'zm', 'edit', 't1', '--comment', 'New comment', '--apply', '--expect', token], t.ctx)
  expect(applyCode).toBe(7)
  expect(t.errJson().error).toMatchObject({ code: 'CONFLICT', message: 'transaction was deleted or is gone' })
})

// --- delete: unknown/already-deleted targets ---

it('delete an unknown id: INVALID_ARGS listing it, dry-run', async () => {
  const { code, t } = await zm(['delete', 'nope'])
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'unknown transaction id: nope' })
})

it('delete a present-but-already-deleted id alongside a live one: dropped with an "already in that state" warning, not an error', async () => {
  const { code, t } = await zm(['delete', 't9', 't1']) // t9 already deleted in the fixture, t1 live
  expect(code).toBe(0)
  const { data, warnings } = t.json()
  expect(data.changes.map((c: any) => c.id)).toEqual(['t1'])
  expect(warnings).toContain('already in that state: t9')
})

it('delete only already-deleted ids: "nothing to change" warning, no error', async () => {
  const { code, t } = await zm(['delete', 't9'])
  expect(code).toBe(0)
  expect(t.json().warnings).toContain('nothing to change: already in that state')
})

it('delete: target already gone by --apply time (removed by sync via a deletion entry) is treated as already applied, with a well-formed envelope', async () => {
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  const dryCode = await run(['node', 'zm', 'delete', 't1'], t.ctx)
  expect(dryCode).toBe(0)
  const token = t.json().data.token
  t.out.length = 0

  const calls: any[] = []
  const syncResponse = { serverTimestamp: 1789000200, deletion: [{ id: 't1', object: 'transaction', stamp: 1789000100, user: 10 }] }
  ;(t.ctx as any).fetch = apiFetch([syncResponse], calls)

  const applyCode = await run(['node', 'zm', 'delete', 't1', '--apply', '--expect', token], t.ctx)
  expect(applyCode).toBe(0)
  expect(calls).toHaveLength(1) // no push
  const out = t.json()
  expect(out.data.applied).toBe(true)
  expect(out.warnings).toContain('already applied')
  // The synthetic post-sync change (base: null, next: { id, deleted: true })
  // must not leak a bogus balanceImpact entry or a `raw: null` key.
  expect(out.data.balanceImpact).toEqual([])
  expect(out.data.changes).toHaveLength(1)
  for (const change of out.data.changes) {
    expect('raw' in change).toBe(false)
  }
})

it('delete: target already gone by --apply time (sync echoes the row with deleted: true, ZenMoney\'s real shape) is treated as already applied', async () => {
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  const dryCode = await run(['node', 'zm', 'delete', 't1'], t.ctx)
  expect(dryCode).toBe(0)
  const token = t.json().data.token
  t.out.length = 0

  const calls: any[] = []
  const preSyncStore = Store.open(t.ctx.paths.cacheDb)
  const originalT1 = preSyncStore.getTransaction('t1')!
  preSyncStore.close()
  const syncResponse = { serverTimestamp: 1789000200, transaction: [{ ...originalT1, deleted: true, changed: 1789000200 }] }
  ;(t.ctx as any).fetch = apiFetch([syncResponse], calls)

  const applyCode = await run(['node', 'zm', 'delete', 't1', '--apply', '--expect', token], t.ctx)
  expect(applyCode).toBe(0)
  expect(calls).toHaveLength(1) // no push
  const out = t.json()
  expect(out.data.applied).toBe(true)
  expect(out.warnings).toContain('already applied')
})

// --- add: conflicting/matching existing id ---

it('add: an id that already exists with matching content warns "nothing to change" instead of erroring', async () => {
  const uuid = '00000000-0000-4000-8000-00000000000a'
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  const seed = Store.open(t.ctx.paths.cacheDb)
  const existing = {
    id: uuid, user: 10, date: '2026-09-20', income: 0, outcome: 10,
    incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln', incomeInstrument: 100, outcomeInstrument: 100,
    tag: null, merchant: null, payee: null, comment: null, deleted: false, created: 1780000000, changed: 1780000000,
  }
  seed.applyDiff({ serverTimestamp: 1789000000, transaction: [existing] }, new Date())
  seed.close()

  const code = await run(['node', 'zm', 'add', '--expense', '10', '--account', 'Card PLN', '--date', '2026-09-20', '--id', uuid], t.ctx)
  expect(code).toBe(0)
  expect(t.json().warnings).toContain('nothing to change: already in that state')
})

it('add: an id that already exists with different content exits CONFLICT on dry-run', async () => {
  const uuid = '00000000-0000-4000-8000-00000000000b'
  const t = seededContext({ env: { ZENMONEY_TOKEN: 'tok' } })
  const seed = Store.open(t.ctx.paths.cacheDb)
  const existing = {
    id: uuid, user: 10, date: '2026-09-20', income: 0, outcome: 999,
    incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln', incomeInstrument: 100, outcomeInstrument: 100,
    tag: null, merchant: null, payee: null, comment: null, deleted: false, created: 1780000000, changed: 1780000000,
  }
  seed.applyDiff({ serverTimestamp: 1789000000, transaction: [existing] }, new Date())
  seed.close()

  const code = await run(['node', 'zm', 'add', '--expense', '10', '--account', 'Card PLN', '--date', '2026-09-20', '--id', uuid], t.ctx)
  expect(code).toBe(7)
  expect(t.errJson().error).toMatchObject({ code: 'CONFLICT', message: `transaction ${uuid} already exists with different content` })
})

// --- add: empty comment/payee are valid (clear semantics), unlike category/account ---

it('add --comment "" and --payee "" are accepted', async () => {
  const { code, t } = await zm(['add', '--expense', '10', '--account', 'Card PLN', '--comment', '', '--payee', ''])
  expect(code).toBe(0)
  expect(t.json().data.applied).toBe(false)
})

it('edit --comment "" and --payee "" are accepted (clear the fields)', async () => {
  // t3 has a non-null payee ('Cafe X') in the fixture, so clearing it is a
  // real change (not dropped as already-in-that-state).
  const { code, t } = await zm(['edit', 't3', '--comment', '', '--payee', ''])
  expect(code).toBe(0)
  const changes = t.json().data.changes
  expect(changes[0].after.payee).toBeNull()
})
