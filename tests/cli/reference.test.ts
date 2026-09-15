import { it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { run } from '../../src/cli/program.js'
import { seededContext, testContext } from '../helpers.js'
import { Store } from '../../src/store/store.js'
import { fixtureDiff } from '../fixtures/diff.js'
import type { ZmTransaction } from '../../src/api/types.js'

const zm = async (args: string[], over = {}) => { const t = seededContext(over); const code = await run(['node', 'zm', ...args], t.ctx); return { code, t } }

// Writes owners.yaml into a context's config dir before the command under
// test runs against it — every owners.yaml CLI test needs the file to exist
// before `zm` reads it, so this can't reuse the one-shot `zm()` helper above.
function withOwnersFile(t: ReturnType<typeof seededContext>, yaml: string): void {
  mkdirSync(t.ctx.paths.configDir, { recursive: true })
  writeFileSync(join(t.ctx.paths.configDir, 'owners.yaml'), yaml)
}
const FAMILY_OWNERS_YAML = 'owners:\n  alex:\n    accounts: ["Card PLN"]\n  sam:\n    accounts: ["acc-partner"]\n'

it('users', async () => {
  const { code, t } = await zm(['users'])
  expect(code).toBe(0)
  expect(t.json().data).toEqual([
    { id: 10, login: 'owner', currency: 'EUR', isMain: true },
    { id: 11, login: 'partner', currency: 'EUR', isMain: false },
  ])
  expect(t.json().meta.lastSyncAt).toBe('2026-09-15T08:00:00.000Z')
})
it('users --owner filters to the matching user', async () => {
  const { code, t } = await zm(['users', '--owner', 'partner'])
  expect(code).toBe(0)
  expect(t.json().data).toEqual([{ id: 11, login: 'partner', currency: 'EUR', isMain: false }])
})
it('categories rejects a non-all --owner', async () => {
  const { code, t } = await zm(['categories', '--owner', 'me'])
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--owner is not supported by categories' })
})
it('rates rejects a non-all --owner', async () => {
  const { code, t } = await zm(['rates', '--owner', 'partner'])
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--owner is not supported by rates' })
})
it('accounts hides archived by default', async () => {
  const { t } = await zm(['accounts'])
  expect(t.json().data.map((a: any) => a.title)).not.toContain('Old Cash')
  expect(t.json().data.find((a: any) => a.id === 'acc-partner')).toEqual({ id: 'acc-partner', title: 'Card Partner', type: 'ccard', currency: 'PLN', balance: 90000, inBalance: true, archived: false, owner: 'partner' })
  const all = await zm(['accounts', '--archived'])
  expect(all.t.json().data).toHaveLength(5)
})
it('accounts respects --owner', async () => {
  const { t } = await zm(['accounts', '--owner', 'partner'])
  expect(t.json().data.map((a: any) => a.id)).toEqual(['acc-partner'])
})
// Once owners.yaml exists, `accounts.owner` reports the file's owner name
// (or null when unassigned) instead of the ZenMoney login, and --owner
// switches from ZenMoney-user semantics to name/unassigned/all semantics.
it('accounts reports owners.yaml owner names once the file exists', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  expect(await run(['node', 'zm', 'accounts'], t.ctx)).toBe(0)
  const data = t.json().data
  expect(data.find((a: any) => a.id === 'acc-pln').owner).toBe('alex')
  expect(data.find((a: any) => a.id === 'acc-partner').owner).toBe('sam')
  expect(data.find((a: any) => a.id === 'acc-eur').owner).toBeNull() // unassigned
})
it('accounts --owner <name> filters by owners.yaml owner name', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  expect(await run(['node', 'zm', 'accounts', '--owner', 'alex'], t.ctx)).toBe(0)
  expect(t.json().data.map((a: any) => a.id)).toEqual(['acc-pln'])
})
it('accounts --owner unassigned lists accounts matched by no owner entry', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  expect(await run(['node', 'zm', 'accounts', '--owner', 'unassigned'], t.ctx)).toBe(0)
  const ids = t.json().data.map((a: any) => a.id)
  expect(ids).toContain('acc-eur')
  expect(ids).not.toContain('acc-pln')
  expect(ids).not.toContain('acc-partner')
})
it('accounts --owner <unknown name> exits 2 with a did-you-mean hint, once owners.yaml exists', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  const code = await run(['node', 'zm', 'accounts', '--owner', 'ale'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: 'unknown owner: ale' })
  expect(t.errJson().error.hint).toMatch(/alex/)
})
// The old ZenMoney-user semantics (me/login/id) stop applying once
// owners.yaml exists — 'me' isn't a name in FAMILY_OWNERS_YAML, so it's
// rejected exactly like any other unknown owner name.
it('accounts --owner me is rejected once owners.yaml exists (old semantics no longer apply)', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  const code = await run(['node', 'zm', 'accounts', '--owner', 'me'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
})
it('tx --owner <name> filters transactions by owners.yaml owner name', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  expect(await run(['node', 'zm', 'tx', '--month', '2026-09', '--owner', 'sam'], t.ctx)).toBe(0)
  expect(t.json().data.map((x: any) => x.id)).toEqual(['t2'])
  expect(t.json().data[0].owner).toBe('sam')
})
it('zm owners: no file returns an empty owners list, all non-archived accounts unassigned, and a hint warning', async () => {
  const { t } = await zm(['owners'])
  expect(t.json().data.owners).toEqual([])
  expect(t.json().data.file).toBeNull()
  const unassignedIds = t.json().data.unassigned.map((a: any) => a.id)
  expect(unassignedIds).toContain('acc-pln')
  expect(unassignedIds).not.toContain('acc-old') // archived, excluded by default
  expect(t.json().warnings[0]).toMatch(/owners\.yaml/)
})
it('zm owners: lists each owner\'s matched accounts and unassigned accounts, from the file', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  expect(await run(['node', 'zm', 'owners'], t.ctx)).toBe(0)
  const data = t.json().data
  expect(data.file).toBe(join(t.ctx.paths.configDir, 'owners.yaml'))
  expect(data.owners).toEqual([
    { name: 'alex', accounts: [{ id: 'acc-pln', title: 'Card PLN' }] },
    { name: 'sam', accounts: [{ id: 'acc-partner', title: 'Card Partner' }] },
  ])
  expect(data.unassigned.map((a: any) => a.id).sort()).toEqual(['acc-debt', 'acc-eur'])
})
it('zm owners --archived includes archived accounts in unassigned', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  expect(await run(['node', 'zm', 'owners', '--archived'], t.ctx)).toBe(0)
  expect(t.json().data.unassigned.map((a: any) => a.id)).toContain('acc-old')
})
it('zm owners rejects a non-all --owner', async () => {
  const { code, t } = await zm(['owners', '--owner', 'me'])
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS', message: '--owner is not supported by owners' })
})
it('categories flat and tree', async () => {
  const flat = (await zm(['categories'])).t.json().data
  expect(flat).toContainEqual({ id: 'cafe', path: 'Food/Cafe', parentId: 'eat', kind: 'expense' })
  expect(flat).toContainEqual({ id: 'salary', path: 'Salary', parentId: null, kind: 'income' })
  const tree = (await zm(['categories', '--tree'])).t.json().data
  expect(tree.find((c: any) => c.id === 'health').children.map((c: any) => c.id)).toEqual(['dent'])
})
it('categories --tree treats a tag with a missing (dangling) parent id as top-level', async () => {
  const t = testContext()
  const store = Store.open(t.ctx.paths.cacheDb)
  const diff = fixtureDiff()
  diff.tag!.push({ id: 'orphan', user: 10, title: 'Orphan', parent: 'no-such-tag', showIncome: false, showOutcome: true, changed: 1780000000 })
  store.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  store.close()
  const code = await run(['node', 'zm', 'categories', '--tree'], t.ctx)
  expect(code).toBe(0)
  expect(t.json().data.some((c: any) => c.id === 'orphan')).toBe(true)
})
it('categories --tree table flattens children with a two-space indent, never falling back to JSON', async () => {
  const { t } = await zm(['categories', '--tree', '--format', 'table'])
  const out = t.out.join('')
  expect(out).not.toMatch(/^\s*\[/) // not a raw JSON array dump
  // The id column is padded to width 6 (the longest id, "health"/"salary"), then
  // joined with a literal 2-space separator: that's 4 spaces of natural padding
  // after "dent" (4 chars) before the path column even starts. The child row's
  // indent must add exactly 2 more, for exactly 6 total — anchored at line start
  // so padding can't be mistaken for the indent (a loose `\s+` match, which
  // backtracks to fit any number of spaces, would pass even without one).
  expect(out).toMatch(/^dent {6}Health\/Dentist/m)
})
it('tx table flattens counterpart into counterpartAccount/Amount/Currency columns', async () => {
  const { t } = await zm(['tx', '--month', '2026-09', '--type', 'transfer', '--format', 'table'])
  const out = t.out.join('')
  expect(out).toMatch(/counterpartAccount\s+counterpartAmount\s+counterpartCurrency/)
  expect(out).toMatch(/Card PLN\s+11700\s+PLN/)
})
it('rates relative to main user currency', async () => {
  const { t } = await zm(['rates'])
  expect(t.json().meta.base).toBe('EUR')
  expect(t.json().meta.note).toMatch(/current/)
  expect(t.json().data).toContainEqual({ currency: 'PLN', rate: 0.222222 })
})
it('rates only counts instruments used by non-deleted transactions', async () => {
  const t = testContext()
  const store = Store.open(t.ctx.paths.cacheDb)
  const diff = fixtureDiff()
  const deletedUsdTx: ZmTransaction = {
    id: 'tDelUsd', user: 10, date: '2026-09-01', income: 0, outcome: 5, incomeAccount: 'acc-pln', outcomeAccount: 'acc-pln',
    incomeInstrument: 1, outcomeInstrument: 1, tag: null, merchant: null, payee: null, comment: null,
    deleted: true, created: 1780000000, changed: 1780000000,
  }
  diff.transaction!.push(deletedUsdTx)
  store.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  store.close()
  const code = await run(['node', 'zm', 'rates'], t.ctx)
  expect(code).toBe(0)
  expect(t.json().data.map((r: any) => r.currency)).not.toContain('USD')
})
it('tx --type rejects an empty list', async () => {
  const { code, t } = await zm(['tx', '--type', ''])
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
  const commaOnly = await zm(['tx', '--type', ','])
  expect(commaOnly.code).toBe(2)
  expect(commaOnly.t.errJson().error.code).toBe('INVALID_ARGS')
})
it('tx with filters and limit', async () => {
  const { t } = await zm(['tx', '--month', '2026-09', '--type', 'expense,refund', '--category', 'Groceries', '--limit', '2'])
  expect(t.json().data.map((x: any) => x.id)).toEqual(['t5', 't2'])
  expect(t.json().meta).toMatchObject({ from: '2026-09-01', to: '2026-09-30', category: 'Groceries', total: 3, returned: 2 })
})
it('tx warns on an unknown --currency but still succeeds', async () => {
  const { code, t } = await zm(['tx', '--currency', 'ZZZ'])
  expect(code).toBe(0)
  expect(t.json().data).toEqual([])
  expect(t.json().warnings).toContain('unknown currency: ZZZ')
})
it('tx does not warn for a currency that is actually used', async () => {
  const { t } = await zm(['tx', '--currency', 'PLN'])
  expect(t.json().warnings).toBeUndefined()
})
it('tx meta lists every applied filter', async () => {
  const { t } = await zm(['tx', '--month', '2026-09', '--account', 'Card PLN', '--currency', 'PLN', '--type', 'expense,refund', '--search', 'food', '--limit', '5', '--owner', 'me'])
  expect(t.json().meta).toMatchObject({
    from: '2026-09-01', to: '2026-09-30', category: null, owner: 'me',
    account: 'acc-pln', currency: 'PLN', type: ['expense', 'refund'], search: 'food', limit: 5,
  })
})
it('stale cache adds warning', async () => {
  const { t } = await zm(['users'], { now: () => new Date('2026-09-18T09:00:00Z') })
  expect(t.json().warnings).toEqual(['cache is 3 days old, run zm sync'])
})
it('bad category exits 2', async () => {
  const { code, t } = await zm(['tx', '--category', 'Nope'])
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
})
it('no cache exits 5', async () => {
  const t = testContext()
  expect(await run(['node', 'zm', 'users'], t.ctx)).toBe(5)
})
// Review round item 10: A-4's corruption handling exercised through the
// actual CLI command layer (ctx.openStore()), not just Store directly.
it('a garbage cache file makes `zm users` exit 5 with a delete-and-resync hint', async () => {
  const t = testContext()
  mkdirSync(dirname(t.ctx.paths.cacheDb), { recursive: true })
  writeFileSync(t.ctx.paths.cacheDb, 'not a sqlite file at all')
  const code = await run(['node', 'zm', 'users'], t.ctx)
  expect(code).toBe(5)
  expect(t.errJson().error).toMatchObject({
    code: 'NO_CACHE',
    hint: `delete ${t.ctx.paths.cacheDb} and run zm sync --full`,
  })
})
it('a row with invalid raw JSON makes `zm users` exit 5', async () => {
  const t = seededContext()
  const raw = new DatabaseSync(t.ctx.paths.cacheDb)
  raw.exec('PRAGMA journal_mode=WAL')
  raw.prepare(`UPDATE "user" SET raw = 'not json' WHERE id = '10'`).run()
  raw.close()
  const code = await run(['node', 'zm', 'users'], t.ctx)
  expect(code).toBe(5)
  expect(t.errJson().error).toMatchObject({ code: 'NO_CACHE' })
})
