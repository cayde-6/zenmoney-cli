import { it, expect, beforeAll } from 'vitest'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store/store.js'
import { fixtureDiff } from '../fixtures/diff.js'

const home = mkdtempSync(join(tmpdir(), 'zm-e2e-'))
// HOME/USERPROFILE included alongside XDG_CONFIG_HOME/XDG_CACHE_HOME as
// defense in depth: every path this CLI resolves already comes from the
// latter two (see src/paths.ts), but pinning HOME/USERPROFILE too means a
// spawned process can never fall back to the real home even indirectly.
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, 'cfg'),
  XDG_CACHE_HOME: join(home, 'cache'),
  ZENMONEY_TOKEN: '',
  ZM_DISABLE_KEYCHAIN: '1',
}
const zm = (...args: string[]) => spawnSync('node', ['dist/bin.js', ...args], { env, encoding: 'utf8' })

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { stdio: 'ignore' })
  const s = Store.open(join(home, 'cache', 'zm', 'zm.sqlite'))
  s.applyDiff(fixtureDiff(), new Date())
  s.close()
}, 60_000)

it('runs spend from built binary', () => {
  const r = zm('spend', '--by', 'category', '--month', '2026-09')
  expect(r.status).toBe(0)
  expect(JSON.parse(r.stdout).data.find((g: any) => g.key === 'Groceries').amounts[0].amount).toBe(4500)
})
it('exit codes from built binary', () => {
  expect(zm('sync').status).toBe(3)
  expect(zm('spend').status).toBe(2)
  expect(zm('--version').stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
})
it('help mentions SKILL.md and examples', () => {
  const helpOut = zm('--help').stdout
  const match = /Agent guide: (.+)/.exec(helpOut)
  expect(match).not.toBeNull()
  expect(existsSync(match![1]!.trim())).toBe(true)
  expect(zm('spend', '--help').stdout).toMatch(/Examples:/)
})
it('tx --help documents --search matching payee too', () => {
  expect(zm('tx', '--help').stdout).toMatch(/--search <text>\s+substring match on merchant, payee, comment, category/)
})
it('status works with no token/cache and never prints a token', () => {
  const r = zm('status')
  expect(r.status).toBe(0)
  const data = JSON.parse(r.stdout).data
  expect(data.cache).toHaveProperty('path')
  expect(data.token).toEqual({ source: null })
})
it('--help documents that --owner me is the main user, not necessarily the token holder', () => {
  // `\s+` between words tolerates commander's own line-wrapping of this long
  // option description at whatever width the terminal happens to be, rather
  // than asserting an exact wrap point that shifts whenever the text grows.
  expect(zm('--help').stdout).toMatch(/main user of the family\s+account/)
  expect(zm('--help').stdout).toMatch(/not\s+necessarily\s+the\s+token\s+holder/)
})
it('EPIPE from a closed stdout pipe exits quietly, with no stack trace on stderr', async () => {
  const child = spawn('node', ['dist/bin.js', 'categories', '--format', 'table'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  // Close our end of the read pipe immediately, before the child has a chance
  // to write: its next stdout.write() then fails with EPIPE.
  child.stdout.destroy()
  const exitCode: number | null = await new Promise((resolve, reject) => {
    child.on('exit', code => resolve(code))
    child.on('error', reject)
  })
  expect(exitCode).toBe(0) // unchanged from what `categories --format table` would normally exit with
  expect(stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/) // no JS stack trace frame
}, 15000)
it('auth exits 2 within ~8s when stdin never sends data and is never closed', async () => {
  const child = spawn('node', ['dist/bin.js', 'auth'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const start = Date.now()
  // Deliberately never write to or close child.stdin: this is exactly the "no
  // token provided" no-cache-required scenario a bad piped invocation without
  // stdin data would hit, and it must not hang the process forever.
  const exitCode: number | null = await new Promise((resolve, reject) => {
    child.on('exit', code => resolve(code))
    child.on('error', reject)
  })
  const elapsedMs = Date.now() - start
  expect(exitCode).toBe(2)
  expect(elapsedMs).toBeLessThan(8000)
}, 15000)
it('edit dry-run works from the built binary, no network', () => {
  const r = zm('edit', 't1', '--comment', 'X')
  expect(r.status).toBe(0)
  expect(JSON.parse(r.stdout).data.applied).toBe(false)
})
it('edit --apply without --expect exits 2 from the built binary', () => {
  const r = zm('edit', 't1', '--comment', 'X', '--apply')
  expect(r.status).toBe(2)
  expect(JSON.parse(r.stderr).error.code).toBe('INVALID_ARGS')
})
