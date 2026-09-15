import { it, expect, vi } from 'vitest'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  isPublished,
  exitCodeFor,
  EXIT_PUBLISHED,
  EXIT_NOT_PUBLISHED,
  EXIT_USAGE_ERROR,
  EXIT_UNEXPECTED_ERROR,
} from '../../.github/scripts/npm-published.mjs'

// isPublished takes an injectable command runner, so this never shells out
// to the real npm registry.

it('returns true when npm view resolves the exact requested version', () => {
  const run = vi.fn(() => '1.2.3\n')
  expect(isPublished('@cayde-6/zenmoney-cli', '1.2.3', run)).toBe(true)
  expect(run).toHaveBeenCalledWith('npm', ['view', '@cayde-6/zenmoney-cli@1.2.3', 'version'], { encoding: 'utf8' })
})
it('returns false when npm view throws (unpublished name or version, e.g. E404)', () => {
  const run = vi.fn(() => { throw new Error('npm error code E404') })
  expect(isPublished('@cayde-6/zenmoney-cli', '9.9.9', run)).toBe(false)
})
it('returns false if npm view somehow resolves a different version than requested', () => {
  const run = vi.fn(() => '1.2.4\n')
  expect(isPublished('@cayde-6/zenmoney-cli', '1.2.3', run)).toBe(false)
})

// exitCodeFor is the exit-code mapping release.yml relies on: 0/1 are the
// only two codes it treats as a real answer; everything else must fail the
// job closed (see release.yml's "Check whether this version is already
// published" step).
it('maps published -> EXIT_PUBLISHED (0)', () => {
  expect(exitCodeFor('pkg', '1.2.3', () => true)).toBe(EXIT_PUBLISHED)
  expect(EXIT_PUBLISHED).toBe(0)
})
it('maps not published -> EXIT_NOT_PUBLISHED (1)', () => {
  expect(exitCodeFor('pkg', '1.2.3', () => false)).toBe(EXIT_NOT_PUBLISHED)
  expect(EXIT_NOT_PUBLISHED).toBe(1)
})
it('maps missing name or version -> EXIT_USAGE_ERROR, without even calling checkPublished', () => {
  const checkPublished = vi.fn(() => true)
  expect(exitCodeFor(undefined, '1.2.3', checkPublished)).toBe(EXIT_USAGE_ERROR)
  expect(exitCodeFor('pkg', undefined, checkPublished)).toBe(EXIT_USAGE_ERROR)
  expect(EXIT_USAGE_ERROR).toBe(2)
  expect(checkPublished).not.toHaveBeenCalled()
})
it('maps an unexpected thrown error -> EXIT_UNEXPECTED_ERROR, never 0 or 1', () => {
  const code = exitCodeFor('pkg', '1.2.3', () => { throw new Error('boom') })
  expect(code).toBe(EXIT_UNEXPECTED_ERROR)
  expect(EXIT_UNEXPECTED_ERROR).toBe(3)
  expect(code).not.toBe(EXIT_PUBLISHED)
  expect(code).not.toBe(EXIT_NOT_PUBLISHED)
})

// Regression test for the fail-open bug: the "run main when executed
// directly" guard used to compare fileURLToPath(import.meta.url) to
// process.argv[1] as raw strings, so invoking the script through a
// symlinked path never ran main() at all — node then exits 0 by default,
// which release.yml's `if node ...; then` reads as "already published" and
// wrongly skips `npm publish`. Invoking through a symlink with bad args
// must still run main() and exit non-zero (EXIT_USAGE_ERROR), proving
// main() actually ran instead of falling through to node's implicit exit 0.
it('runs main() (and exits non-zero on bad args) when invoked through a symlinked path', () => {
  const realPath = resolve(import.meta.dirname, '../../.github/scripts/npm-published.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'npm-published-symlink-'))
  const linkPath = join(dir, 'npm-published-link.mjs')
  symlinkSync(realPath, linkPath)

  const result = spawnSync(process.execPath, [linkPath], { encoding: 'utf8' })

  expect(result.status).toBe(EXIT_USAGE_ERROR)
  expect(result.stderr).toContain('usage:')
})
