import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ZmError } from '../errors.js'
import type { ZmAccount } from '../api/types.js'

// Optional `<configDir>/owners.yaml`: splits accounts (and, through them,
// transactions) between family members when ZenMoney's own `user`/`role`
// fields can't — see docs/architecture.md's "Owner semantics" section for
// why this file exists at all. Each owner name maps to a list of match
// entries; an entry matches an account by exact id or by a case-insensitive,
// trimmed substring of the account's title.
export interface OwnersFile { owners: Map<string, string[]> }

// Deliberately excludes `_`/emoji/spaces: unlike the account-matching
// entries below (which may contain any Unicode), an owner name also has to
// work as a bare `--owner <name>` CLI argument.
const OWNER_NAME_RE = /^[A-Za-z0-9._-]+$/
// Both are meaningful `--owner` values in their own right once this file
// exists (see resolveOwnerName in query/filters.ts) and must never be
// shadowed by a same-named owner entry.
const RESERVED_OWNER_NAMES = new Set(['all', 'unassigned'])
// Same concern as budget/files.ts's FORBIDDEN_LIMIT_KEYS: a name of
// `__proto__`/`constructor`/`prototype` risks mutating an object's prototype
// instead of being treated as an ordinary key.
const FORBIDDEN_OWNER_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Parses and validates one owners.yaml's shape. Does not look at any real
// account — that's matchOwners' job.
export function parseOwnersFile(text: string, source: string): OwnersFile {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (e) {
    throw new ZmError('INVALID_ARGS', `${source}: invalid yaml: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (raw === null || raw === undefined) return { owners: new Map() }
  if (!isPlainObject(raw)) throw new ZmError('INVALID_ARGS', `${source}: must be a yaml object`)

  for (const key of Object.keys(raw)) {
    if (key !== 'owners') throw new ZmError('INVALID_ARGS', `${source}: unknown key "${key}"`)
  }

  const owners = new Map<string, string[]>()
  if ('owners' in raw && raw.owners !== null && raw.owners !== undefined) {
    const rawOwners = raw.owners
    if (!isPlainObject(rawOwners)) throw new ZmError('INVALID_ARGS', `${source}: "owners" must be an object`)

    for (const [name, value] of Object.entries(rawOwners)) {
      if (FORBIDDEN_OWNER_KEYS.has(name)) {
        throw new ZmError('INVALID_ARGS', `${source}: owner name "${name}" is not allowed`)
      }
      if (!OWNER_NAME_RE.test(name)) {
        throw new ZmError('INVALID_ARGS', `${source}: invalid owner name "${name}"`, 'owner names must match [A-Za-z0-9._-]+')
      }
      if (RESERVED_OWNER_NAMES.has(name)) {
        throw new ZmError('INVALID_ARGS', `${source}: owner name "${name}" is reserved`)
      }
      if (!isPlainObject(value)) {
        throw new ZmError('INVALID_ARGS', `${source}: owner "${name}" must be an object`)
      }
      for (const key of Object.keys(value)) {
        if (key !== 'accounts') throw new ZmError('INVALID_ARGS', `${source}: owner "${name}": unknown key "${key}"`)
      }
      const accounts = value.accounts
      if (!Array.isArray(accounts) || !accounts.every((a): a is string => typeof a === 'string')) {
        throw new ZmError('INVALID_ARGS', `${source}: owner "${name}": "accounts" must be an array of strings`)
      }
      owners.set(name, accounts)
    }
  }
  return { owners }
}

export function ownersFilePath(configDir: string): string {
  return join(configDir, 'owners.yaml')
}

// Returns null when the file doesn't exist at all — that's the signal
// callers use to fall back to today's ZenMoney-user owner semantics (see
// query/filters.ts's resolveOwner vs. resolveOwnerName).
export function loadOwnersFile(configDir: string): OwnersFile | null {
  const file = ownersFilePath(configDir)
  if (!existsSync(file)) return null
  return parseOwnersFile(readFileSync(file, 'utf8'), file)
}

function matchesAccount(entry: string, account: ZmAccount): boolean {
  if (entry === account.id) return true
  const q = entry.trim().toLowerCase()
  if (q === '') return false
  return account.title.trim().toLowerCase().includes(q)
}

// Maps each account id to the single owner name whose `accounts` entries
// match it; an account left out of the result matched no entry at all
// ("unassigned"). Two different owners both matching the same account is a
// configuration error, not a silent pick of either one.
export function matchOwners(accounts: Map<string, ZmAccount>, file: OwnersFile): Map<string, string> {
  const result = new Map<string, string>()
  for (const account of accounts.values()) {
    let owner: string | null = null
    for (const [name, entries] of file.owners) {
      if (!entries.some(e => matchesAccount(e, account))) continue
      if (owner !== null && owner !== name) {
        throw new ZmError(
          'INVALID_ARGS',
          `account "${account.title}" (${account.id}) matches both owner "${owner}" and "${name}"`,
          'give the account to only one owner in owners.yaml',
        )
      }
      owner = name
    }
    if (owner !== null) result.set(account.id, owner)
  }
  return result
}
