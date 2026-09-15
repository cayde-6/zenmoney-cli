import { it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Cyrillic block, U+0400-U+04FF (as numeric code points rather than a regex
// literal, so this file itself never contains a literal Cyrillic character).
const CYRILLIC_START = 0x0400
const CYRILLIC_END = 0x04ff

function hasCyrillic(line: string): boolean {
  for (const ch of line) {
    const cp = ch.codePointAt(0)!
    if (cp >= CYRILLIC_START && cp <= CYRILLIC_END) return true
  }
  return false
}

// The repository must contain no Russian text anywhere (code, tests,
// fixtures, docs, examples, help, comments) — see CLAUDE.md/audit brief.
// The CLI still handles Cyrillic category titles from real ZenMoney data at
// runtime (see tests/repo/cyrillic-runtime.test.ts's code-point-built title
// tests); this only guards against committing Cyrillic *source* text.
it('no git-tracked text file contains Cyrillic characters', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter(f => f !== 'package-lock.json')

  const offenders: string[] = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue // deleted-but-still-staged, submodule, etc. — nothing to scan
    }
    if (text.includes('\0')) continue // binary file, not text — not this test's concern
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (hasCyrillic(lines[i]!)) offenders.push(`${file}:${i + 1}`)
    }
  }
  expect(offenders).toEqual([])
})
