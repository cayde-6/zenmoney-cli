import { it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { run } from '../../src/cli/program.js'
import { seededContext, testContext, withOwnersFile, FAMILY_OWNERS_YAML } from '../helpers.js'
import { Store } from '../../src/store/store.js'
import { fixtureDiff } from '../fixtures/diff.js'
import type { ZmTransaction } from '../../src/api/types.js'

const zm = async (args: string[], over = {}) => { const t = seededContext(over); const code = await run(['node', 'zm', ...args], t.ctx); return { code, t } }

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
// Review round item 3: a family-member owner NAME has no natural mapping
// onto ZenMoney's own user list, so `zm users` rejects any non-'all'
// --owner once owners.yaml exists, instead of quietly reinterpreting it (or
// worse, still applying the old me/login/id semantics as if nothing changed).
it('users rejects a non-all --owner once owners.yaml exists', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  const code = await run(['node', 'zm', 'users', '--owner', 'partner'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({
    code: 'INVALID_ARGS',
    message: '--owner is not supported by users',
    hint: 'owners.yaml is active; zm users lists ZenMoney users -- use zm owners',
  })
})
it('users --owner all (the default) still works once owners.yaml exists', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  const code = await run(['node', 'zm', 'users'], t.ctx)
  expect(code).toBe(0)
  expect(t.json().data).toHaveLength(2)
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
// Review round item 5.
it('zm owners --format table renders owner/id/title rows, "(unassigned)" for unassigned accounts', async () => {
  const t = seededContext()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  expect(await run(['node', 'zm', 'owners', '--format', 'table'], t.ctx)).toBe(0)
  const out = t.out.join('')
  expect(out).toMatch(/owner\s+id\s+title/)
  expect(out).toMatch(/alex\s+acc-pln\s+Card PLN/)
  expect(out).toMatch(/\(unassigned\)\s+acc-eur\s+Cash EUR/)
})
// Review round item 8: a mismatched entry (typo, renamed/closed account, ...)
// should be visible, not silently swallowed as "just doesn't match".
it('zm owners warns about an entry matching zero accounts', async () => {
  const t = seededContext()
  withOwnersFile(t, 'owners:\n  alex:\n    accounts: ["Card PLN", "NoSuchAccountAtAll"]\n')
  expect(await run(['node', 'zm', 'owners'], t.ctx)).toBe(0)
  expect(t.json().warnings).toContain('entry "NoSuchAccountAtAll" of owner alex matches no accounts')
})
it('zm owners warns about a SHORT (<= 2 letters/digits) text entry matching more than half of all accounts', async () => {
  const t = seededContext()
  // "Ca" (case-insensitive) matches Card PLN, Cash EUR, Card Partner, and
  // Old Cash — 4 of the fixture's 5 accounts (only Debts doesn't match).
  withOwnersFile(t, 'owners:\n  alex:\n    accounts: ["Ca"]\n')
  expect(await run(['node', 'zm', 'owners'], t.ctx)).toBe(0)
  expect(t.json().warnings).toContain('entry "Ca" of owner alex matches 4 of 5 accounts')
})
// Follow-up: a longer text entry (more than 2 letters/digits) matching most
// of the account list is not flagged — only a SHORT entry is likely to be
// an accidental catch-all; a longer one that happens to match a lot is
// more plausibly intentional (e.g. a shared surname).
it('zm owners does NOT warn about a longer (> 2 letters/digits) text entry, even if it matches more than half', async () => {
  const t = testContext()
  const store = Store.open(t.ctx.paths.cacheDb)
  const diff = fixtureDiff()
  for (const a of diff.account!) a.title = `Family ${a.title}`
  store.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  store.close()
  withOwnersFile(t, 'owners:\n  alex:\n    accounts: ["Family"]\n')
  expect(await run(['node', 'zm', 'owners'], t.ctx)).toBe(0)
  const warnings = t.json().warnings ?? []
  expect(warnings.some((w: string) => w.includes('"Family"') && w.includes('matches') && w.includes('accounts'))).toBe(false)
})
// Review round follow-up: an emoji-prefix convention across most/all
// accounts is a legitimate, common naming scheme, not noise — emoji/symbol
// entries already require exact whole-grapheme matches (see
// entryMatchesAccount), so they can never over-match by accident. Never
// warn about "matches more than half" for a symbol-only entry, however
// many accounts it matches; the zero-match warning still applies to them.
it('zm owners never warns "matches more than half" for an emoji/symbol-only entry, even matching every account', async () => {
  const CAR = String.fromCodePoint(0x1f697) // built from its code point, not typed literally
  const t = testContext()
  const store = Store.open(t.ctx.paths.cacheDb)
  const diff = fixtureDiff()
  for (const a of diff.account!) a.title = `${CAR} ${a.title}`
  store.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  store.close()
  withOwnersFile(t, `owners:\n  alex:\n    accounts: ["${CAR}"]\n`)
  expect(await run(['node', 'zm', 'owners'], t.ctx)).toBe(0)
  const warnings = t.json().warnings ?? []
  expect(warnings.some((w: string) => w.includes('matches') && w.includes('accounts'))).toBe(false)
})
it('zm owners still warns about a zero-match emoji entry (the zero-match warning is unaffected)', async () => {
  const HEART = String.fromCodePoint(0x2764) // built from its code point
  const t = seededContext()
  withOwnersFile(t, `owners:\n  alex:\n    accounts: ["Card PLN", "${HEART}"]\n`)
  expect(await run(['node', 'zm', 'owners'], t.ctx)).toBe(0)
  expect(t.json().warnings).toContain(`entry "${HEART}" of owner alex matches no accounts`)
})

// Review round item 2: conflicts.
it('a non-archived account matched by two different owners exits 2 with a pin-by-id hint', async () => {
  const t = seededContext()
  withOwnersFile(t, 'owners:\n  alex:\n    accounts: ["Card"]\n  sam:\n    accounts: ["PLN"]\n')
  const code = await run(['node', 'zm', 'accounts'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
  expect(t.errJson().error.message).toContain('Card PLN')
  expect(t.errJson().error.message).toContain('acc-pln')
  expect(t.errJson().error.hint).toBe('pin it to one owner by account id, see zm owners --archived')
})
it('a conflict on an archived-only account is a warning, and the command still succeeds', async () => {
  const t = seededContext()
  // "Old" matches only "Old Cash" (acc-old, archived); "Cash" matches both
  // "Cash EUR" (acc-eur, unique to sam) and "Old Cash" (conflicting with alex).
  withOwnersFile(t, 'owners:\n  alex:\n    accounts: ["Old"]\n  sam:\n    accounts: ["Cash"]\n')
  const code = await run(['node', 'zm', 'accounts', '--archived'], t.ctx)
  expect(code).toBe(0)
  expect(t.json().data.find((a: any) => a.id === 'acc-old').owner).toBeNull() // treated as unassigned
  expect(t.json().data.find((a: any) => a.id === 'acc-eur').owner).toBe('sam')
  expect(t.json().warnings).toContain('account "Old Cash" (acc-old) matches owners alex and sam; treated as unassigned')
})

// Review round item 9: a broken (directory/unreadable) owners.yaml.
it('a directory at owners.yaml exits 2 (INVALID_ARGS) naming the path', async () => {
  const t = seededContext()
  mkdirSync(join(t.ctx.paths.configDir, 'owners.yaml'), { recursive: true })
  const code = await run(['node', 'zm', 'accounts'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
  expect(t.errJson().error.message).toContain(join(t.ctx.paths.configDir, 'owners.yaml'))
})
it('invalid yaml syntax in owners.yaml exits 2 (INVALID_ARGS)', async () => {
  const t = seededContext()
  withOwnersFile(t, 'owners:\n  alex: [1, 2\n')
  const code = await run(['node', 'zm', 'accounts'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
})

// Review round item 4/7: owners.yaml with an `owners:` key but no owners
// defined under it — 'all'/'unassigned' still work (every account is
// unassigned), but a name is rejected with a hint saying the file defines none.
it('owners.yaml with no owners defined: --owner all/unassigned still work; a name is rejected with a "defines no owners" hint', async () => {
  const t = seededContext()
  withOwnersFile(t, 'owners:\n')
  expect(await run(['node', 'zm', 'accounts'], t.ctx)).toBe(0)
  expect(t.json().data.every((a: any) => a.owner === null)).toBe(true)

  const t2 = seededContext()
  withOwnersFile(t2, 'owners:\n')
  expect(await run(['node', 'zm', 'accounts', '--owner', 'unassigned'], t2.ctx)).toBe(0)
  expect(t2.json().data.length).toBeGreaterThan(0)

  const t3 = seededContext()
  withOwnersFile(t3, 'owners:\n')
  const code = await run(['node', 'zm', 'accounts', '--owner', 'alex'], t3.ctx)
  expect(code).toBe(2)
  expect(t3.errJson().error.hint).toMatch(/defines no owners/)
})
// Review round item 6: a bad --owner value must be caught even when every
// account ends up filtered out for some OTHER reason first (here:
// --archived isn't passed and every account happens to be archived) — a
// version that only resolves --owner lazily inside the per-account filter
// predicate would never even run that predicate on an empty list, and
// silently return an empty result with exit 0 instead of failing.
it('accounts --owner is resolved before filtering, even when every account is archived and --archived is not passed (regression)', async () => {
  const t = testContext()
  const store = Store.open(t.ctx.paths.cacheDb)
  const diff = fixtureDiff()
  for (const a of diff.account!) a.archive = true
  store.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  store.close()
  const code = await run(['node', 'zm', 'accounts', '--owner', 'totally-bogus-owner'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
})
it('accounts --owner is resolved before filtering under owners.yaml too, same regression', async () => {
  const t = testContext()
  const store = Store.open(t.ctx.paths.cacheDb)
  const diff = fixtureDiff()
  for (const a of diff.account!) a.archive = true
  store.applyDiff(diff, new Date('2026-09-15T08:00:00Z'))
  store.close()
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  const code = await run(['node', 'zm', 'accounts', '--owner', 'totally-bogus-owner'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error.code).toBe('INVALID_ARGS')
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
