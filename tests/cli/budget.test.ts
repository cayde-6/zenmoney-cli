import { it, expect } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../../src/cli/program.js'
import { seededContext, testContext } from '../helpers.js'
import { parseBudgetFile } from '../../src/budget/files.js'

it('init writes template, refuses overwrite, --force overwrites', async () => {
  const t = seededContext()
  expect(await run(['node', 'zm', 'budget', 'init'], t.ctx)).toBe(0)
  const text = readFileSync(join(t.ctx.paths.budgetDir, 'default.yaml'), 'utf8')
  expect(text).toMatch(/^currency: EUR/m)
  expect(text).toMatch(/#\s+Здоровье\/Стоматология: 0/)
  expect(await run(['node', 'zm', 'budget', 'init'], t.ctx)).toBe(2)
  expect(await run(['node', 'zm', 'budget', 'init', '--force'], t.ctx)).toBe(0)
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
  writeFileSync(join(t.ctx.paths.budgetDir, 'default.yaml'), 'currency: PLN\nlimits:\n  Продукты: 10000\n')
  expect(await run(['node', 'zm', 'budget', 'status', '--owner', 'me'], t.ctx)).toBe(0)
  const d = t.json().data
  expect(d.month).toBe('2026-09')
  expect(d.rows[0]).toMatchObject({ category: 'Продукты', spent: 2500, usedPct: 25 })
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
it('status table includes an otherCurrencies column', async () => {
  const t = seededContext({ now: () => new Date('2026-09-15T12:00:00') })
  mkdirSync(t.ctx.paths.budgetDir, { recursive: true })
  writeFileSync(join(t.ctx.paths.budgetDir, 'default.yaml'), 'currency: PLN\nlimits:\n  Еда: 15\n')
  expect(await run(['node', 'zm', 'budget', 'status', '--format', 'table'], t.ctx)).toBe(0)
  expect(t.out.join('')).toMatch(/Еда\s+PLN\s+15\s+0\s+15\s+0\s+-50\s+EUR 20/)
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
