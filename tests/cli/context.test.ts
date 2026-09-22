import { it, expect, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { readStdinWithTimeout, realContext } from '../../src/cli/context.js'
import { resolvePaths } from '../../src/paths.js'
import { Store } from '../../src/store/store.js'

// Low-level, stream-based stdin reader behind ctx.readStdin(): the 5s timeout
// (used by `zm auth` to avoid hanging forever on a pipe that never sends
// anything) must apply only while no data has arrived yet, and must never
// keep the process alive once it fires. See src/cli/commands/sync.ts for how
// zm auth consumes ctx.readStdin(), and tests/e2e/bin.test.ts for the
// end-to-end version of case (a) below against the real binary.

it('rejects after ms when nothing is ever written, and destroys the stream', async () => {
  vi.useFakeTimers()
  try {
    const stream = new PassThrough()
    const promise = readStdinWithTimeout(stream, 1000)
    const expectation = expect(promise).rejects.toMatchObject({ code: 'INVALID_ARGS', message: 'no token provided' })
    await vi.advanceTimersByTimeAsync(1000)
    await expectation
    expect(stream.destroyed).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it('applies the timeout only until the first chunk arrives, then reads to the end with no timeout', async () => {
  vi.useFakeTimers()
  try {
    const stream = new PassThrough()
    const promise = readStdinWithTimeout(stream, 1000)
    await vi.advanceTimersByTimeAsync(500)
    stream.write('first-')
    // Well past the original 1000ms budget: must not fire since a chunk already arrived.
    await vi.advanceTimersByTimeAsync(2000)
    stream.write('second')
    stream.end()
    await expect(promise).resolves.toBe('first-second')
  } finally {
    vi.useRealTimers()
  }
})

it('clears the timer on success, leaving nothing pending', async () => {
  vi.useFakeTimers()
  try {
    const stream = new PassThrough()
    const promise = readStdinWithTimeout(stream, 1000)
    stream.end('data')
    await promise
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('clears the timer when the stream errors before any data arrives', async () => {
  vi.useFakeTimers()
  try {
    const stream = new PassThrough()
    const promise = readStdinWithTimeout(stream, 1000)
    const expectation = expect(promise).rejects.toThrow('boom')
    stream.emit('error', new Error('boom'))
    await expectation
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

// The `Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)` guard exists
// because a stream can also deliver string chunks (e.g. once `setEncoding`
// is used upstream) rather than only Buffers — both must accumulate correctly.
it('accepts string data chunks, not just Buffer chunks', async () => {
  const stream = new PassThrough()
  stream.setEncoding('utf8') // makes 'data' emit strings instead of Buffers
  const promise = readStdinWithTimeout(stream, 1000)
  stream.end('hello')
  await expect(promise).resolves.toBe('hello')
})

// realContext() wiring: paths/keychain selection driven by env/platform/home,
// which the (test-only) overrides parameter lets these tests pin down
// deterministically instead of depending on the host this suite runs on.
// Every real call site (bin.ts) still calls realContext() with no arguments.
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'zm-realctx-'))
}

it('resolves paths from process.env/platform/os.homedir() by default (no overrides)', () => {
  const ctx = realContext()
  expect(ctx.platform).toBe(process.platform)
  expect(ctx.paths).toEqual(resolvePaths(process.env, process.platform, homedir()))
})

it('overrides thread through to resolvePaths exactly as given', () => {
  const home = tempHome()
  const env = { XDG_CONFIG_HOME: join(home, 'cfg') }
  const ctx = realContext({ env, platform: 'linux', home })
  expect(ctx.paths).toEqual(resolvePaths(env, 'linux', home))
})

it('enables a real macOS Keychain only on darwin, and only when ZM_DISABLE_KEYCHAIN is not "1"', () => {
  const home = tempHome()
  expect(realContext({ env: {}, platform: 'darwin', home }).keychain).not.toBeNull()
  expect(realContext({ env: { ZM_DISABLE_KEYCHAIN: '1' }, platform: 'darwin', home }).keychain).toBeNull()
})

it('never enables the Keychain on non-darwin platforms, regardless of ZM_DISABLE_KEYCHAIN', () => {
  const home = tempHome()
  expect(realContext({ env: {}, platform: 'linux', home }).keychain).toBeNull()
  expect(realContext({ env: {}, platform: 'win32', home }).keychain).toBeNull()
})

it('openStore throws NO_CACHE when the resolved cache db does not exist yet', () => {
  const ctx = realContext({ env: {}, platform: 'linux', home: tempHome() })
  expect(() => ctx.openStore()).toThrow(expect.objectContaining({ code: 'NO_CACHE' }))
})

it('openStore opens the real cache db once it exists', () => {
  const ctx = realContext({ env: {}, platform: 'linux', home: tempHome() })
  Store.open(ctx.paths.cacheDb).close()
  const store = ctx.openStore()
  expect(store.hasData()).toBe(false)
  store.close()
})

it('stdout/stderr write to the real process streams', () => {
  const ctx = realContext({ env: {}, platform: 'linux', home: tempHome() })
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    ctx.stdout('out-line')
    ctx.stderr('err-line')
    expect(outSpy).toHaveBeenCalledWith('out-line')
    expect(errSpy).toHaveBeenCalledWith('err-line')
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
  }
})

it('now() returns the current time, and fetch is wired to the real global fetch', () => {
  const ctx = realContext({ env: {}, platform: 'linux', home: tempHome() })
  const before = Date.now()
  const now = ctx.now().getTime()
  expect(now).toBeGreaterThanOrEqual(before)
  expect(now).toBeLessThanOrEqual(Date.now())
  expect(ctx.fetch).toBe(globalThis.fetch)
})

// realContext()'s readStdin is `() => readStdinWithTimeout(process.stdin, 5000)` —
// never exercised by the readStdinWithTimeout tests above, which call the
// exported helper directly against a stream of their own. Swap the real
// process.stdin for a PassThrough just for this test, restoring the original
// property descriptor afterwards so nothing else in the suite is affected.
it('realContext.uuid returns a v4 uuid', () => {
  expect(realContext({ env: {} }).uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

it('readStdin reads from the real process.stdin', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin')!
  const fake = new PassThrough()
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true })
  try {
    const ctx = realContext({ env: {}, platform: 'linux', home: tempHome() })
    const promise = ctx.readStdin()
    fake.end('piped-token')
    await expect(promise).resolves.toBe('piped-token')
  } finally {
    Object.defineProperty(process, 'stdin', original)
  }
})
