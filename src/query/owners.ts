import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse, parseDocument, isMap, isScalar } from 'yaml'
import { ZmError } from '../errors.js'
import type { ZmAccount } from '../api/types.js'

// Optional `<configDir>/owners.yaml`: splits accounts (and, through them,
// transactions) between family members when ZenMoney's own `user`/`role`
// fields can't — see docs/architecture.md's "Owner semantics" section for
// why this file exists at all. Each owner name maps to a list of match
// entries; an entry matches an account by exact id or by a case-insensitive,
// trimmed substring of the account's title (see entryMatchesAccount).
export interface OwnersFile { owners: Map<string, string[]> }

// Must start with a letter (so it can never look like a negative number, a
// bare digit, or a leading `.`/`-`/`_`), then any mix of
// letters/digits/`.`/`_`/`-` — unlike the account-matching entries below
// (which may contain any Unicode, including emoji), an owner name also has
// to work as a bare `--owner <name>` CLI argument.
const OWNER_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/
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

// A bare (unquoted) yaml key that looks like a number, boolean, or null
// resolves to that type, not a string — `parse()`'s plain-JS-object result
// can't tell that apart from an explicitly-quoted string key with the same
// spelling (both end up as the same JS object property, since object keys
// are always strings), so this walks the parsed Document's own key nodes
// once, up front, and returns the stringified spelling of every "owners"
// entry whose key resolved to a non-string. `parseOwnersFile` rejects any
// owner name found in this set outright, rather than silently accepting a
// key that was never actually written as a string.
function nonStringOwnerKeys(text: string): Set<string> {
  const bad = new Set<string>()
  let doc: ReturnType<typeof parseDocument>
  try {
    doc = parseDocument(text)
  } catch {
    return bad // invalid syntax is reported separately, by parse() itself
  }
  const top = doc.contents
  if (!isMap(top)) return bad
  for (const pair of top.items) {
    if (!(isScalar(pair.key) && pair.key.value === 'owners' && isMap(pair.value))) continue
    for (const ownerPair of pair.value.items) {
      if (isScalar(ownerPair.key) && typeof ownerPair.key.value !== 'string') {
        bad.add(String(ownerPair.key.value))
      }
    }
  }
  return bad
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
    const badKeys = nonStringOwnerKeys(text)

    for (const [name, value] of Object.entries(rawOwners)) {
      if (badKeys.has(name)) {
        throw new ZmError('INVALID_ARGS', `${source}: owner name "${name}" must be a yaml string key`, 'quote it, e.g. "123":')
      }
      if (FORBIDDEN_OWNER_KEYS.has(name)) {
        throw new ZmError('INVALID_ARGS', `${source}: owner name "${name}" is not allowed`)
      }
      if (!OWNER_NAME_RE.test(name)) {
        throw new ZmError('INVALID_ARGS', `${source}: invalid owner name "${name}"`, 'owner names must start with a letter and match [A-Za-z][A-Za-z0-9._-]*')
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
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    // Most plausibly a directory at this path, or a permission problem —
    // either way, a raw Node fs error (EISDIR/EACCES/...) must not leak out
    // as an unhandled 'UNEXPECTED' exception.
    throw new ZmError('INVALID_ARGS', `${file}: cannot read owners.yaml: ${e instanceof Error ? e.message : String(e)}`)
  }
  return parseOwnersFile(text, file)
}

// Built from its code point, not typed as a literal character: U+FE0F
// (variation selector-16) is invisible in a source file, so a literal
// would be indistinguishable from an accidental empty/missing character at
// a glance. Many emoji keyboards append it to a base emoji, but it's
// cosmetic (selects the emoji-style glyph), not part of the character's
// identity.
const VARIATION_SELECTOR_16 = String.fromCodePoint(0xfe0f)
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// NFC-normalizes and strips every U+FE0F from both sides before any
// comparison, so an entry/title differing only by that invisible selector
// (e.g. a bare heart vs. a heart with an explicit emoji-style selector)
// still matches.
function normalizeMatchText(s: string): string {
  return s.trim().normalize('NFC').split(VARIATION_SELECTOR_16).join('')
}

function graphemes(s: string): string[] {
  return [...graphemeSegmenter.segment(s)].map(g => g.segment)
}

// How many Unicode letters/digits a (trimmed) entry contains — 0 means a
// bare emoji/symbol entry (matched only by whole grapheme clusters, see
// entryMatchesAccount below); `zm owners`' "matches more than half of all
// accounts" warning uses this to skip symbol-only entries entirely (they
// can't over-match by accident, since they require an exact whole-cluster
// match) and to only flag a short text entry (a couple of letters/digits),
// not a longer one that happens to legitimately match a lot of accounts.
export function letterOrDigitCount(entry: string): number {
  return [...entry.trim()].filter(ch => LETTER_OR_DIGIT_RE.test(ch)).length
}

// Whether `needle` (already split into graphemes) appears as a contiguous,
// exact run of whole graphemes somewhere in `haystack` — not merely as a
// code-point substring, which could match a fragment of a larger cluster
// (e.g. the bare base emoji of a ZWJ family/skin-tone sequence).
function graphemeSequenceMatches(needle: string[], haystack: string[]): boolean {
  if (needle.length === 0) return false
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((g, j) => g === haystack[i + j])) return true
  }
  return false
}

// An entry matches an account if it equals the account id exactly, or
// matches the account's (trimmed) title. Title matching has two modes:
//   - an entry containing at least one letter or digit is a plain
//     case-insensitive substring match (today's behavior, unchanged);
//   - an entry with NO letters or digits at all (a bare emoji/symbol) must
//     instead align to whole Unicode grapheme-cluster boundaries in the
//     title (via Intl.Segmenter) — so a bare "man" emoji does not match
//     inside a "man+ZWJ+woman" family cluster, and a skin-toned emoji only
//     matches by its full sequence, never by its bare base emoji. Users
//     should copy the exact emoji from the account title (as `zm owners`
//     prints it) rather than retyping it from scratch.
// Both sides are NFC-normalized and stripped of U+FE0F (variation
// selector-16) first, so a title/entry differing only by that invisible
// selector still matches.
export function entryMatchesAccount(entry: string, account: ZmAccount): boolean {
  if (entry === account.id) return true
  const trimmedEntry = entry.trim()
  if (trimmedEntry === '') return false

  if (LETTER_OR_DIGIT_RE.test(trimmedEntry)) {
    const q = normalizeMatchText(trimmedEntry).toLowerCase()
    if (q === '') return false
    return normalizeMatchText(account.title).toLowerCase().includes(q)
  }

  const normEntry = normalizeMatchText(trimmedEntry)
  const normTitle = normalizeMatchText(account.title)
  return graphemeSequenceMatches(graphemes(normEntry), graphemes(normTitle))
}

export interface OwnerMatchResult {
  ownerOf: Map<string, string> // accountId -> owner name
  // Non-fatal issues found while matching — currently just an archived
  // account whose conflict was resolved as unassigned instead of failing
  // the whole command (see below).
  warnings: string[]
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// Maps each account id to the single owner name whose `accounts` entries
// match it; an account left out of the result matched no entry at all
// ("unassigned"). Considers every account, archived included — the
// `--archived` flag only ever affects what a command *displays*, never
// what owners.yaml itself matches.
//
// Precedence when more than one owner matches the same account: an exact
// account-id entry always wins over another owner's mere title/substring
// match (no conflict in that case) — an id is unambiguous by construction,
// so there's nothing to arbitrate. A genuine conflict (two owners both
// matching by id, or neither matching by id) is a configuration error on a
// non-archived account (INVALID_ARGS, naming the account and every
// matching owner) — but on an ARCHIVED account it's downgraded to a
// warning and the account is treated as unassigned instead, so a stale
// closed account's leftover title overlap can never break every other
// command that opens the cache.
export function matchOwners(accounts: Map<string, ZmAccount>, file: OwnersFile): OwnerMatchResult {
  const ownerOf = new Map<string, string>()
  const warnings: string[] = []

  for (const account of accounts.values()) {
    const exactOwners: string[] = []
    const substringOwners: string[] = []
    for (const [name, entries] of file.owners) {
      let exact = false
      let substring = false
      for (const e of entries) {
        if (e === account.id) exact = true
        else if (entryMatchesAccount(e, account)) substring = true
      }
      if (exact) exactOwners.push(name)
      else if (substring) substringOwners.push(name)
    }

    const winners = exactOwners.length > 0 ? exactOwners : substringOwners
    if (winners.length === 0) continue
    if (winners.length === 1) {
      ownerOf.set(account.id, winners[0]!)
      continue
    }

    // winners.length >= 2: a genuine conflict.
    if (account.archive) {
      warnings.push(`account "${account.title}" (${account.id}) matches owners ${joinNames(winners)}; treated as unassigned`)
    } else {
      throw new ZmError(
        'INVALID_ARGS',
        `account "${account.title}" (${account.id}) matches owners ${joinNames(winners)}`,
        'pin it to one owner by account id, see zm owners --archived',
      )
    }
  }

  return { ownerOf, warnings }
}
