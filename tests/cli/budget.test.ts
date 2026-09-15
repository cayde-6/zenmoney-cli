import { it, expect } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../../src/cli/program.js'
import { seededContext, testContext, withOwnersFile, FAMILY_OWNERS_YAML } from '../helpers.js'
import { parseBudgetFile } from '../../src/budget/files.js'

it('init writes template, refuses overwrite, --force overwrites', async () => {
  const t = seededContext()
  expect(await run(['node', 'zm', 'budget', 'init'], t.ctx)).toBe(0)
  const text = readFileSync(join(t.ctx.paths.budgetDir, 'default.yaml'), 'utf8')
  expect(text).toMatch(/^currency: EUR/m)
  expect(text).toMatch(/#\s+Health\/Dentist: 0/)
  expect(await run(['node', 'zm', 'budget', 'init'], t.ctx)).toBe(2)
  expect(await run(['node', 'zm', 'budget', 'init', '--force'], t.ctx)).toBe(0)
})
// Review round item 9: budget init creates ~/.config/zm/budget (and thus
// ~/.config/zm itself, via mkdir's `recursive: true`) on a fresh home —
// the config dir itself must end up at 0700, not just the budget/ subdir.
it('init on a fresh home creates the config dir itself at mode 700, not just budget/', async () => {
  const t = seededContext()
  expect(existsSync(t.ctx.paths.configDir)).toBe(false)
  expect(await run(['node', 'zm', 'budget', 'init'], t.ctx)).toBe(0)
  expect(statSync(t.ctx.paths.configDir).mode & 0o777).toBe(0o700)
  expect(statSync(t.ctx.paths.budgetDir).mode & 0o777).toBe(0o700)
})
it('init template uncomments into valid yaml', async () => {
  const t = seededContext()
  expect(await run(['node', 'zm', 'budget', 'init'], t.ctx)).toBe(0)
  const text = readFileSync(join(t.ctx.paths.budgetDir, 'default.yaml'), 'utf8')
  const uncommented = text.split('\n').map(l => (l.startsWith('  # ') ? '  ' + l.slice('  # '.length) : l)).join('\n')
  expect(() => parseBudgetFile(uncommented, 'default.yaml')).not.toThrow()
})
it('status right after a fresh init: comment-only limits, no plans yet', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  expect(await run(['node', 'zm', 'budget', 'init'], t.ctx)).toBe(0)
  t.out.length = 0
  expect(await run(['node', 'zm', 'budget', 'status'], t.ctx)).toBe(0)
  const d = t.json().data
  expect(d.rows).toEqual([])
  expect(d.unplanned.length).toBeGreaterThan(0)
})
it('status uses owner filter and current month', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  mkdirSync(t.ctx.paths.budgetDir, { recursive: true })
  writeFileSync(join(t.ctx.paths.budgetDir, 'default.yaml'), 'currency: PLN\nlimits:\n  Groceries: 10000\n')
  expect(await run(['node', 'zm', 'budget', 'status', '--owner', 'me'], t.ctx)).toBe(0)
  const d = t.json().data
  expect(d.month).toBe('2026-09')
  expect(d.rows[0]).toMatchObject({ category: 'Groceries', spent: 2500, usedPct: 25 })
})
// Review round item 10: a smoke test that owners.yaml's name-based --owner
// reaches `budget status` through the shared applyFilters path.
it('status --owner <name> filters by owners.yaml owner name once the file exists', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  withOwnersFile(t, FAMILY_OWNERS_YAML)
  mkdirSync(t.ctx.paths.budgetDir, { recursive: true })
  writeFileSync(join(t.ctx.paths.budgetDir, 'default.yaml'), 'currency: PLN\nlimits:\n  Groceries: 10000\n')
  const code = await run(['node', 'zm', 'budget', 'status', '--owner', 'alex'], t.ctx)
  expect(code).toBe(0)
  expect(t.json().meta.owner).toBe('alex')
})
it('status skips a limit key that no longer resolves, warning and listing it as unresolved', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  mkdirSync(t.ctx.paths.budgetDir, { recursive: true })
  writeFileSync(
    join(t.ctx.paths.budgetDir, 'default.yaml'),
    'currency: PLN\nlimits:\n  Groceries: 10000\n  NoSuchCategoryAnymore: { amount: 500, currency: EUR }\n',
  )
  expect(await run(['node', 'zm', 'budget', 'status'], t.ctx)).toBe(0)
  const body = t.json()
  expect(body.data.rows.map((r: any) => r.category)).toEqual(['Groceries'])
  expect(body.data.unresolved).toEqual([{ key: 'NoSuchCategoryAnymore', amount: 500, currency: 'EUR' }])
  expect(body.warnings).toContain(
    `unknown budget category "NoSuchCategoryAnymore" in ${join(t.ctx.paths.budgetDir, 'default.yaml')}, skipped`,
  )
})
it('status still fails hard on a duplicate-key collision between two resolvable keys', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  mkdirSync(t.ctx.paths.budgetDir, { recursive: true })
  writeFileSync(join(t.ctx.paths.budgetDir, 'default.yaml'), 'currency: PLN\nlimits:\n  Cafe: 100\n  Food/Cafe: 200\n')
  const code = await run(['node', 'zm', 'budget', 'status'], t.ctx)
  expect(code).toBe(2)
  expect(t.errJson().error).toMatchObject({ code: 'INVALID_ARGS' })
})
it('suggest prints raw yaml', async () => {
  // now is the last day of August, so August itself hasn't fully elapsed yet:
  // the window must stop at July even though the target month (September) would
  // otherwise allow August.
  const t = seededContext({ now: () => new Date('2026-08-31T12:00:00') })
  expect(await run(['node', 'zm', 'budget', 'suggest', '--months', '3'], t.ctx)).toBe(0)
  expect(t.out.join('')).toMatch(/^# zm budget suggest: median of 2026-05\.\.2026-07, generated for 2026-09/)
})
it('suggest window is capped by the current month, not just the target month', async () => {
  // now is mid-September; the default target is October, but September hasn't
  // fully elapsed, so the window must end at August, not September.
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  expect(await run(['node', 'zm', 'budget', 'suggest', '--months', '3'], t.ctx)).toBe(0)
  expect(t.out.join('')).toMatch(/^# zm budget suggest: median of 2026-06\.\.2026-08, generated for 2026-10/)
})
it('suggest falls back to the main user currency when no pairs qualify', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  // A window with no fixture transactions at all: nothing qualifies.
  expect(await run(['node', 'zm', 'budget', 'suggest', '--months', '1', '--month', '2020-02'], t.ctx)).toBe(0)
  const { parse } = await import('yaml')
  expect(parse(t.out.join(''))).toMatchObject({ currency: 'EUR', limits: {} })
})
it('status table includes an otherCurrencies column', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  mkdirSync(t.ctx.paths.budgetDir, { recursive: true })
  writeFileSync(join(t.ctx.paths.budgetDir, 'default.yaml'), 'currency: PLN\nlimits:\n  Food: 15\n')
  expect(await run(['node', 'zm', 'budget', 'status', '--format', 'table'], t.ctx)).toBe(0)
  expect(t.out.join('')).toMatch(/Food\s+PLN\s+15\s+0\s+15\s+0\s+-50\s+EUR 20/)
})
it('status rejects an invalid --month before touching the store', async () => {
  const t = testContext() // no cache at all
  expect(await run(['node', 'zm', 'budget', 'status', '--month', '2026-13'], t.ctx)).toBe(2)
})
it('suggest rejects --months 0', async () => {
  const t = seededContext()
  expect(await run(['node', 'zm', 'budget', 'suggest', '--months', '0'], t.ctx)).toBe(2)
})
it('suggest rejects an unknown --format before touching the store', async () => {
  const t = testContext() // no cache at all
  expect(await run(['node', 'zm', 'budget', 'suggest', '--format', 'xml'], t.ctx)).toBe(2)
})
it('suggest accepts --format table but still prints raw yaml, not a table', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  expect(await run(['node', 'zm', 'budget', 'suggest', '--months', '3', '--format', 'table'], t.ctx)).toBe(0)
  expect(t.out.join('')).toMatch(/^# zm budget suggest:/)
})
it('suggest without a cache fails with NO_CACHE', async () => {
  const t = testContext() // no cache at all
  expect(await run(['node', 'zm', 'budget', 'suggest'], t.ctx)).toBe(5)
})
it('suggest warns to stderr on a stale cache', async () => {
  const t = seededContext({ now: () => new Date('2026-09-20T12:00:00Z') }) // cache synced 2026-09-15T08:00:00Z
  expect(await run(['node', 'zm', 'budget', 'suggest'], t.ctx)).toBe(0)
  expect(t.err.join('')).toMatch(/^warning: cache is \d+ days old, run zm sync/m)
})
