import { it, expect } from 'vitest'
import { mkdtempSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDirMode, chmodIfExists } from '../src/fsutil.js'

it('ensureDirMode creates a missing dir (and parents) at the given mode on posix', () => {
  const base = mkdtempSync(join(tmpdir(), 'zm-fsutil-'))
  const dir = join(base, 'a', 'b')
  ensureDirMode(dir, 0o700, 'linux')
  expect(existsSync(dir)).toBe(true)
  expect(statSync(dir).mode & 0o777).toBe(0o700)
})
it('ensureDirMode skips chmod on win32 without throwing', () => {
  const base = mkdtempSync(join(tmpdir(), 'zm-fsutil-'))
  const dir = join(base, 'c')
  expect(() => ensureDirMode(dir, 0o700, 'win32')).not.toThrow()
  expect(existsSync(dir)).toBe(true)
})
it('chmodIfExists chmods an existing file', () => {
  const base = mkdtempSync(join(tmpdir(), 'zm-fsutil-'))
  const file = join(base, 'f.txt')
  writeFileSync(file, 'x')
  chmodIfExists(file, 0o600, 'linux')
  expect(statSync(file).mode & 0o777).toBe(0o600)
})
it('chmodIfExists silently does nothing for a file that does not exist', () => {
  const base = mkdtempSync(join(tmpdir(), 'zm-fsutil-'))
  const missing = join(base, 'nope.txt')
  expect(() => chmodIfExists(missing, 0o600, 'linux')).not.toThrow()
  expect(existsSync(missing)).toBe(false)
})
it('chmodIfExists is a no-op on win32 even for a file that exists', () => {
  const base = mkdtempSync(join(tmpdir(), 'zm-fsutil-'))
  const file = join(base, 'f2.txt')
  writeFileSync(file, 'x')
  expect(() => chmodIfExists(file, 0o600, 'win32')).not.toThrow()
})
