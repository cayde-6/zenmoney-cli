import { it, expect } from 'vitest'
import { mkdtempSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { resolveToken, saveToken, removeToken, requireToken, macKeychain, type Keychain, type ExecFn } from '../../src/auth/token.js'

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
  expect(saveToken('c', { env: {}, keychain: null, configFile: f })).toBe('config')
  expect(statSync(f).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ token: 'c' })
  expect(resolveToken({ env: {}, keychain: null, configFile: f })).toBe('c')
})
it('saves to keychain when available, removeToken clears both', () => {
  const f = cfg(), k = memKeychain()
  saveToken('c', { env: {}, keychain: null, configFile: f })
  expect(saveToken('k', { env: {}, keychain: k, configFile: f })).toBe('keychain')
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
  expect(saveToken('abc', { env: {}, keychain: macKeychain(exec), configFile: f })).toBe('config')
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
  expect(saveToken('SECRETVALUE', { env: {}, keychain: kc, configFile: f })).toBe('config')
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
  expect(saveToken('TOKEN_NEW_456', { env: {}, keychain: kc, configFile: f })).toBe('config')
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
