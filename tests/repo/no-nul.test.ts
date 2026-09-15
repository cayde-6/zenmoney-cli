import { it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(p))
    else out.push(p)
  }
  return out
}

// A stray literal NUL byte (e.g. from typing a `\0`-style escape into a template
// literal instead of the intended text) makes git treat the file as binary and
// silently corrupts string handling. Guard against it repo-wide.
it('no file under src/ or tests/ contains a NUL byte', () => {
  const files = [...listFiles(join(root, 'src')), ...listFiles(join(root, 'tests'))]
  const offenders = files.filter(f => readFileSync(f).includes(0))
  expect(offenders).toEqual([])
})
