import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppContext } from '../src/cli/context.js'
import { resolvePaths } from '../src/paths.js'
import { Store } from '../src/store/store.js'
import { ZmError } from '../src/errors.js'
import { fixtureDiff } from './fixtures/diff.js'

export function testContext(over: Partial<AppContext> = {}) {
  const out: string[] = [], err: string[] = []
  const paths = over.paths ?? resolvePaths({}, 'linux', mkdtempSync(join(tmpdir(), 'zm-home-')))
  const ctx: AppContext = {
    env: {}, platform: 'linux', now: () => new Date('2026-09-15T12:00:00'),
    paths,
    fetch: (async () => { throw new Error('network disabled in tests') }) as typeof fetch,
    stdout: s => { out.push(s) }, stderr: s => { err.push(s) },
    readStdin: async () => '', isTTY: false,
    keychain: null,
    openStore: () => {
      if (!existsSync(paths.cacheDb)) throw new ZmError('NO_CACHE', 'no local cache', 'run zm sync')
      return Store.open(paths.cacheDb)
    },
    ...over,
  }
  return { ctx, out, err, json: () => JSON.parse(out.join('')), errJson: () => JSON.parse(err.join('')) }
}

export function fixtureStore(): Store {
  const s = Store.memory()
  s.applyDiff(fixtureDiff(), new Date('2026-09-15T08:00:00Z'))
  return s
}

export function seededContext(over: Partial<AppContext> = {}) {
  const t = testContext(over)
  const s = Store.open(t.ctx.paths.cacheDb)
  s.applyDiff(fixtureDiff(), new Date('2026-09-15T08:00:00Z'))
  s.close()
  return t
}

// Writes owners.yaml into a context's config dir before the command under
// test runs against it — shared by every owners.yaml CLI test (reference,
// analytics, budget, status), since none of them can rely on the file
// existing before their own command runs.
export function withOwnersFile(t: { ctx: AppContext }, yaml: string): void {
  mkdirSync(t.ctx.paths.configDir, { recursive: true })
  writeFileSync(join(t.ctx.paths.configDir, 'owners.yaml'), yaml)
}

// A small, synthetic family split matching the shared fixture's accounts
// (Card PLN -> alex, Card Partner -> sam; Cash EUR/Debts/Old Cash left
// unassigned), reused across every owners.yaml CLI test that just needs
// *some* valid file rather than a specific edge case.
export const FAMILY_OWNERS_YAML = 'owners:\n  alex:\n    accounts: ["Card PLN"]\n  sam:\n    accounts: ["acc-partner"]\n'
