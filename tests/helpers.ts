import { mkdtempSync, existsSync } from 'node:fs'
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
