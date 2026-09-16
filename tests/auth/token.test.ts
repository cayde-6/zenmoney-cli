import { it, expect, vi } from 'vitest'
import { mkdtempSync, statSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolveToken, saveToken, removeToken, requireToken, macKeychain, defaultExec, type Keychain, type ExecFn } from '../../src/auth/token.js'

// Spies on the real execFileSync (still calling through to it) so
// defaultExec's stdio wiring can be asserted directly, instead of only
// inferring it indirectly through process output.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

function memKeychain(v: string | null = null): Keychain & { v: string | null } {
  const k = { v, get: () => k.v, set: (t: string) => { k.v = t }, remove: () => { k.v = null } }
  return k
}
const cfg = () => join(mkdtempSync(join(tmpdir(), 'zm-')), 'zm', 'config.json')

it('env wins over keychain and config', () => {
  expect(resolveToken({ env: { ZENMONEY_TOKEN: 'e' }, keychain: memKeychain('k'), configFile: cfg() })).toBe('e')
})
it('keychain wins over config', () => {
  const f = cfg(); saveToken('c', { env: {}, keychain: null, configFile: f })
  expect(resolveToken({ env: {}, keychain: memKeychain('k'), configFile: f })).toBe('k')
})
it('saves to config with mode 600 when no keychain', () => {
  const f = cfg()
  expect(saveToken('c', { env: {}, keychain: null, configFile: f })).toEqual({ saved: 'config', keychainFailed: false })
  expect(statSync(f).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ token: 'c' })
  expect(resolveToken({ env: {}, keychain: null, configFile: f })).toBe('c')
})
it('creates the config dir with mode 700', () => {
  const f = cfg()
  saveToken('c', { env: {}, keychain: null, configFile: f })
  expect(statSync(dirname(f)).mode & 0o777).toBe(0o700)
})
it('writes config atomically (temp file, then rename) and leaves no temp file behind', () => {
  const f = cfg()
  saveToken('c', { env: {}, keychain: null, configFile: f })
  const entries = readdirSync(dirname(f))
  expect(entries).toEqual(['config.json'])
})
it('skips chmod on win32 without throwing', () => {
  const f = cfg()
  expect(saveToken('c', { env: {}, keychain: null, configFile: f, platform: 'win32' })).toEqual({ saved: 'config', keychainFailed: false })
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ token: 'c' })
})
it('saves to keychain when available, removeToken clears both', () => {
  const f = cfg(), k = memKeychain()
  saveToken('c', { env: {}, keychain: null, configFile: f })
  expect(saveToken('k', { env: {}, keychain: k, configFile: f })).toEqual({ saved: 'keychain', keychainFailed: false })
  removeToken({ env: {}, keychain: k, configFile: f })
  expect(resolveToken({ env: {}, keychain: k, configFile: f })).toBeNull()
})
it('requireToken throws AUTH', () => {
  expect(() => requireToken({ env: {}, keychain: null, configFile: cfg() })).toThrow(expect.objectContaining({ code: 'AUTH' }))
})
it('config keeps other keys', () => {
  const f = cfg(); saveToken('a', { env: {}, keychain: null, configFile: f })
  writeFileSync(f, JSON.stringify({ token: 'a', other: 1 }))
  removeToken({ env: {}, keychain: null, configFile: f })
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ other: 1 })
})
it('config that is valid JSON but not a plain object is treated as empty', () => {
  const f = cfg()
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(null))
  expect(resolveToken({ env: {}, keychain: null, configFile: f })).toBeNull()
})

// Regression coverage for the other arm of defaultExec's stdio ternary: no
// `input` argument at all must produce stdio[0] = 'ignore', not 'pipe'.
// Asserted directly against the execFileSync call (via the module spy above),
// not just inferred from output, so collapsing the ternary to a constant
// can't slip past unnoticed.
it('defaultExec omits stdin input and still runs the command', () => {
  vi.mocked(execFileSync).mockClear()
  const out = defaultExec('node', ['-e', 'process.stdout.write("ok")'])
  expect(out).toBe('ok')
  expect(execFileSync).toHaveBeenCalledWith(
    'node',
    ['-e', 'process.stdout.write("ok")'],
    expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
  )
})

it('macKeychain.set sends the token via stdin to `security -i`, never in argv', () => {
  const calls: { file: string; args: string[]; input: string | undefined }[] = []
  const exec: ExecFn = (file, args, input) => {
    calls.push({ file, args, input })
    // the post-write verification read must see the token we just "stored"
    return args[0] === 'find-generic-password' ? 'abc' : ''
  }
  macKeychain(exec).set('abc')
  expect(calls[0]).toEqual({
    file: 'security',
    args: ['-i'],
    input: 'add-generic-password -U -s zenmoney-cli -a zm -w "abc"\n',
  })
})

// Regression test for the real bug: with stdio[0] = 'ignore', execFileSync
// silently drops `input` instead of writing it to the child's stdin. Run
// against a harmless command that echoes stdin back on stdout, so this fails
// loudly (empty output) on the old ['ignore', 'pipe', 'ignore'] stdio array
// instead of only failing indirectly, later, inside `security -i`.
it('defaultExec actually delivers `input` to the child process stdin', () => {
  const out = defaultExec('node', ['-e', 'process.stdin.pipe(process.stdout)'], 'hello from stdin')
  expect(out).toBe('hello from stdin')
})
it('macKeychain.set verifies the value actually landed, and saveToken falls back if it did not', () => {
  // `security -i` can exit 0 (no thrown error) even when the batched command
  // silently failed to store anything — set() must catch that by re-reading.
  const f = cfg()
  const exec: ExecFn = (_file, args) => {
    if (args[0] === '-i') return '' // reports success...
    if (args[0] === 'find-generic-password') throw new Error('not found') // ...but nothing was stored
    throw new Error(`unexpected exec call: ${args.join(' ')}`)
  }
  const kc = macKeychain(exec)
  expect(() => kc.set('abc')).toThrow(expect.objectContaining({ code: 'AUTH' }))
  expect(saveToken('abc', { env: {}, keychain: macKeychain(exec), configFile: f })).toEqual({ saved: 'config', keychainFailed: true })
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ token: 'abc' })
})
it('saveToken rejects tokens with invalid characters before ever touching the keychain or writing config', () => {
  const f = cfg()
  const kc: Keychain = {
    get: () => null,
    set: () => { throw new Error('keychain.set must not be called for an invalid token') },
    remove: () => {},
  }
  for (const bad of ['a"b', 'a\\b', 'a\nb']) {
    expect(() => saveToken(bad, { env: {}, keychain: kc, configFile: f })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  }
  // No silent fallback to config.json either — the file must never be written.
  expect(existsSync(f)).toBe(false)
})
it('macKeychain.set rejects tokens with characters that could break out of the quoted command', () => {
  const exec: ExecFn = () => { throw new Error('exec must not be called for an invalid token') }
  for (const bad of ['a"b', 'a\\b', 'a\nb']) {
    expect(() => macKeychain(exec).set(bad)).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  }
})
it('macKeychain.set never leaks the token through a thrown error', () => {
  const exec: ExecFn = () => { throw new Error('security failed for token SECRETVALUE') }
  const kc = macKeychain(exec)
  let caught: unknown
  try {
    kc.set('SECRETVALUE')
  } catch (e) {
    caught = e
  }
  expect(caught).toMatchObject({ code: 'AUTH' })
  expect((caught as Error).message).not.toContain('SECRETVALUE')
  expect((caught as { hint?: string }).hint).not.toContain('SECRETVALUE')
})
it('saveToken falls back to config when keychain.set throws, without leaking the token', () => {
  const f = cfg()
  const exec: ExecFn = () => { throw new Error('security failed for token SECRETVALUE') }
  const kc = macKeychain(exec)
  expect(saveToken('SECRETVALUE', { env: {}, keychain: kc, configFile: f })).toEqual({ saved: 'config', keychainFailed: true })
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ token: 'SECRETVALUE' })
})

// A keychain whose set() always fails, holding `initial`. Used to check the
// fallback path clears (or fails loudly about) a stale token left behind by a
// previous successful save, so resolveToken doesn't keep preferring it over
// whatever saveToken's caller believes it just saved.
function flakyKeychain(initial: string | null, opts: { removeFails?: boolean } = {}): Keychain {
  let v = initial
  return {
    get: () => v,
    set: () => { throw new Error('keychain set failed') },
    remove: () => { if (!opts.removeFails) v = null },
  }
}

it('saveToken clears a stale Keychain token when set fails but remove succeeds', () => {
  const f = cfg()
  const kc = flakyKeychain('TOKEN_OLD_123')
  expect(saveToken('TOKEN_NEW_456', { env: {}, keychain: kc, configFile: f })).toEqual({ saved: 'config', keychainFailed: true })
  expect(resolveToken({ env: {}, keychain: kc, configFile: f })).toBe('TOKEN_NEW_456')
})
it('saveToken throws AUTH, naming neither token, when a stale Keychain token cannot be removed either', () => {
  const f = cfg()
  const kc = flakyKeychain('TOKEN_OLD_123', { removeFails: true })
  let caught: unknown
  try {
    saveToken('TOKEN_NEW_456', { env: {}, keychain: kc, configFile: f })
  } catch (e) {
    caught = e
  }
  expect(caught).toMatchObject({ code: 'AUTH' })
  expect((caught as Error).message).not.toContain('TOKEN_OLD_123')
  expect((caught as Error).message).not.toContain('TOKEN_NEW_456')
  expect((caught as { hint?: string }).hint).not.toContain('TOKEN_OLD_123')
  expect((caught as { hint?: string }).hint).not.toContain('TOKEN_NEW_456')
})
