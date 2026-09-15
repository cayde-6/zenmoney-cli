import { it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOwnersFile, loadOwnersFile, ownersFilePath, matchOwners } from '../../src/query/owners.js'
import type { ZmAccount } from '../../src/api/types.js'

function account(id: string, title: string): ZmAccount {
  return { id, user: 10, instrument: 100, type: 'cash', title, balance: 0, inBalance: true, archive: false, changed: 0 }
}

it('parses a well-formed owners file', () => {
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["Card Alex", "acc-id-123"]\n  sam:\n    accounts: ["Sam"]\n', 'owners.yaml')
  expect([...file.owners]).toEqual([
    ['alex', ['Card Alex', 'acc-id-123']],
    ['sam', ['Sam']],
  ])
})
it('an absent or empty file parses as no owners', () => {
  expect([...parseOwnersFile('', 'owners.yaml').owners]).toEqual([])
  expect([...parseOwnersFile('owners:\n', 'owners.yaml').owners]).toEqual([])
})
it('rejects unknown top-level keys', () => {
  expect(() => parseOwnersFile('members:\n  alex:\n    accounts: [a]\n', 'owners.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'owners.yaml: unknown key "members"' }),
  )
})
it('rejects invalid yaml syntax with the source name in the error', () => {
  expect(() => parseOwnersFile('owners:\n  alex: [1, 2\n', 'owners.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: expect.stringContaining('owners.yaml: invalid yaml:') }),
  )
})
it('rejects a non-object top-level value', () => {
  expect(() => parseOwnersFile('- a\n- b\n', 'owners.yaml')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
it('rejects an owner name with characters outside [A-Za-z0-9._-]', () => {
  expect(() => parseOwnersFile('owners:\n  "alex smith":\n    accounts: [a]\n', 'owners.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'owners.yaml: invalid owner name "alex smith"' }),
  )
})
it('rejects the reserved owner names "all" and "unassigned"', () => {
  expect(() => parseOwnersFile('owners:\n  all:\n    accounts: [a]\n', 'owners.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'owners.yaml: owner name "all" is reserved' }),
  )
  expect(() => parseOwnersFile('owners:\n  unassigned:\n    accounts: [a]\n', 'owners.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'owners.yaml: owner name "unassigned" is reserved' }),
  )
})
it('rejects __proto__/constructor/prototype as owner names', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    expect(() => parseOwnersFile(`owners:\n  ${key}:\n    accounts: [a]\n`, 'owners.yaml')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGS' }),
    )
  }
})
it('rejects an "owners" value that is not an object', () => {
  expect(() => parseOwnersFile('owners: nope\n', 'owners.yaml')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
it('rejects an owner entry that is not an object', () => {
  expect(() => parseOwnersFile('owners:\n  alex: nope\n', 'owners.yaml')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
it('rejects an unknown key inside an owner entry', () => {
  expect(() => parseOwnersFile('owners:\n  alex:\n    accounts: [a]\n    nickname: Al\n', 'owners.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'owners.yaml: owner "alex": unknown key "nickname"' }),
  )
})
it('rejects a non-array or non-string "accounts" value', () => {
  expect(() => parseOwnersFile('owners:\n  alex:\n    accounts: nope\n', 'owners.yaml')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  expect(() => parseOwnersFile('owners:\n  alex:\n    accounts: [1]\n', 'owners.yaml')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
// Only the owner NAME is restricted to [A-Za-z0-9._-] — an account entry may
// contain any Unicode, e.g. an emoji title prefix, without needing escaping.
it('accepts Unicode (emoji) in account entries', () => {
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["🚗 Alex"]\n', 'owners.yaml')
  expect(file.owners.get('alex')).toEqual(['🚗 Alex'])
})

it('loadOwnersFile returns null when the file does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-owners-'))
  expect(loadOwnersFile(dir)).toBeNull()
})
it('loadOwnersFile reads and parses an existing file at <dir>/owners.yaml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-owners-'))
  writeFileSync(ownersFilePath(dir), 'owners:\n  alex:\n    accounts: [a]\n')
  expect([...loadOwnersFile(dir)!.owners]).toEqual([['alex', ['a']]])
})

it('matchOwners: matches by exact account id', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Some Card')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["acc-1"]\n', 'owners.yaml')
  expect([...matchOwners(accounts, file)]).toEqual([['acc-1', 'alex']])
})
it('matchOwners: matches by case-insensitive, trimmed title substring', () => {
  const accounts = new Map([['acc-1', account('acc-1', '  Card Alex  ')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["card alex"]\n', 'owners.yaml')
  expect([...matchOwners(accounts, file)]).toEqual([['acc-1', 'alex']])
})
it('matchOwners: a blank (whitespace-only) entry matches nothing, rather than every account', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Some Card')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["   "]\n', 'owners.yaml')
  expect(matchOwners(accounts, file).size).toBe(0)
})
it('matchOwners: an account matched by no entry is left out (unassigned)', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Nothing Matches')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["Card Alex"]\n', 'owners.yaml')
  expect(matchOwners(accounts, file).size).toBe(0)
})
it('matchOwners: an account matched by two different owners is a conflict error naming both', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Shared Card')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["Shared"]\n  sam:\n    accounts: ["Card"]\n', 'owners.yaml')
  try {
    matchOwners(accounts, file)
    throw new Error('no throw')
  } catch (e: any) {
    expect(e.code).toBe('INVALID_ARGS')
    expect(e.message).toContain('Shared Card')
    expect(e.message).toContain('acc-1')
    expect(e.message).toContain('alex')
    expect(e.message).toContain('sam')
  }
})
it('matchOwners: two entries of the SAME owner both matching the same account is not a conflict', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Card Alex')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["acc-1", "Card"]\n', 'owners.yaml')
  expect([...matchOwners(accounts, file)]).toEqual([['acc-1', 'alex']])
})
