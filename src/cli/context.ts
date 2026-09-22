import type { Paths } from '../paths.js'
import type { Keychain } from '../auth/token.js'
import { macKeychain } from '../auth/token.js'
import { Store } from '../store/store.js'
import { resolvePaths } from '../paths.js'
import { ZmError } from '../errors.js'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'

export interface AppContext {
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  now: () => Date
  paths: Paths
  fetch: typeof fetch
  stdout: (s: string) => void
  stderr: (s: string) => void
  readStdin: () => Promise<string>
  isTTY: boolean
  keychain: Keychain | null // null when not on macOS
  openStore: () => Store // opens paths.cacheDb; used by commands
  uuid: () => string // injected so tests get deterministic ids
}

// Reads a stream to completion, guarded by a timeout that applies only while
// NO data has arrived yet: a non-TTY `zm auth` invocation with nothing
// actually piped in (so nothing ever arrives, and the stream never ends) would
// otherwise hang forever instead of failing. Once the first chunk arrives the
// timeout is cleared for good — a slow-but-real multi-chunk pipe must not be
// mistaken for a hung one just because it takes longer than `ms` overall.
//
// On timeout (or any other rejection) the stream is destroyed so its 'data'
// listener stops holding the event loop open — otherwise a real process would
// never exit even after this promise has settled.
export function readStdinWithTimeout(stream: Readable, ms = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let timer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('error', onError)
      if (timer) { clearTimeout(timer); timer = null }
    }
    const fail = (err: Error) => {
      cleanup()
      stream.destroy()
      reject(err)
    }
    const onData = (chunk: Buffer | string) => {
      if (timer) { clearTimeout(timer); timer = null } // timeout only guards the wait for the FIRST chunk
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const onEnd = () => {
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onError = (err: Error) => fail(err)

    timer = setTimeout(
      () => fail(new ZmError('INVALID_ARGS', 'no token provided', 'pipe the token via stdin or run zm auth in a terminal')),
      ms,
    )
    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onError)
  })
}

// `overrides` exists only so tests can inject a deterministic env/platform/home
// (e.g. to exercise the darwin-only Keychain branch, or the win32 chmod-skip
// paths, without depending on the host this test suite happens to run on) —
// every real call site (bin.ts) calls realContext() with no arguments, so the
// defaults below are exactly the previous, unconditional behavior.
export function realContext(overrides: {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  home?: string
} = {}): AppContext {
  const env = overrides.env ?? process.env
  const platform = overrides.platform ?? process.platform
  const home = overrides.home ?? os.homedir()
  const paths = resolvePaths(env, platform, home)
  return {
    env,
    platform,
    now: () => new Date(),
    paths,
    fetch: globalThis.fetch,
    stdout: s => { process.stdout.write(s) },
    stderr: s => { process.stderr.write(s) },
    readStdin: () => readStdinWithTimeout(process.stdin, 5000),
    isTTY: Boolean(process.stdin.isTTY),
    // ZM_DISABLE_KEYCHAIN=1 skips the macOS Keychain entirely (used by tests, so a
    // token left in a developer's real Keychain can never leak into a test run).
    keychain: platform === 'darwin' && env.ZM_DISABLE_KEYCHAIN !== '1' ? macKeychain() : null,
    openStore: () => {
      if (!existsSync(paths.cacheDb)) throw new ZmError('NO_CACHE', 'no local cache', 'run zm sync')
      return Store.open(paths.cacheDb, { platform })
    },
    uuid: () => randomUUID(),
  }
}
