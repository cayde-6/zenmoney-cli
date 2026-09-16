import { it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOwnersFile, loadOwnersFile, ownersFilePath, matchOwners, entryMatchesAccount, letterOrDigitCount } from '../../src/query/owners.js'
import type { ZmAccount } from '../../src/api/types.js'

function account(id: string, title: string, over: Partial<ZmAccount> = {}): ZmAccount {
  return { id, user: 10, instrument: 100, type: 'cash', title, balance: 0, inBalance: true, archive: false, changed: 0, ...over }
}

// Emoji/symbols used below are built from code points, never typed literally,
// per the no-Cyrillic/no-NUL repo convention extended here to keep this test
// file's own source free of hand-typed multibyte literals.
const CAR = String.fromCodePoint(0x1f697) // car
const HEART = String.fromCodePoint(0x2764) // heavy black heart
const FE0F = String.fromCodePoint(0xfe0f) // variation selector-16
const MAN = String.fromCodePoint(0x1f468)
const WOMAN = String.fromCodePoint(0x1f469)
const ZWJ = String.fromCodePoint(0x200d)
const FAMILY = MAN + ZWJ + WOMAN // one grapheme cluster (man ZWJ woman)
const MERMAID = String.fromCodePoint(0x1f9dc)
const SKIN_LIGHT = String.fromCodePoint(0x1f3fb)
const FEMALE_SIGN = String.fromCodePoint(0x2640)
const MERMAID_LIGHT_FEMALE = MERMAID + SKIN_LIGHT + ZWJ + FEMALE_SIGN + FE0F // one grapheme cluster
const KEYCAP_MARK = String.fromCodePoint(0x20e3) // combining enclosing keycap
const KEYCAP_ONE = '1' + FE0F + KEYCAP_MARK // digit "1" + U+FE0F + U+20E3 — a keycap digit sequence

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
// Review round: owner names must START with a letter — a name like "1alex"
// or "-alex" or "_alex" is syntactically inside [A-Za-z0-9._-] but must
// still be rejected.
it('rejects an owner name that does not start with a letter', () => {
  for (const name of ['1alex', '-alex', '_alex', '.alex']) {
    expect(() => parseOwnersFile(`owners:\n  "${name}":\n    accounts: [a]\n`, 'owners.yaml')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGS', message: `owners.yaml: invalid owner name "${name}"` }),
    )
  }
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
// Review round: a bare (unquoted) numeric yaml key resolves to a number, not
// a string — reject it explicitly rather than silently stringifying it,
// even though "123" would also fail the must-start-with-a-letter check; a
// key like `1e2` could otherwise round-trip through Number->String as a
// different-looking string than what was written.
it('rejects a bare numeric owner key (yaml resolves it to a number, not a string)', () => {
  expect(() => parseOwnersFile('owners:\n  123:\n    accounts: [a]\n', 'owners.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS' }),
  )
})
// Review round follow-up item 4: two owner names differing only by case are
// ambiguous once --owner matches case-insensitively (see resolveOwnerName)
// — reject the file outright rather than silently letting one shadow the
// other depending on Map iteration order.
it('rejects two owner names that are equal case-insensitively', () => {
  expect(() => parseOwnersFile('owners:\n  Alex:\n    accounts: [a]\n  alex:\n    accounts: [b]\n', 'owners.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS' }),
  )
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
  const file = parseOwnersFile(`owners:\n  alex:\n    accounts: ["${CAR} Alex"]\n`, 'owners.yaml')
  expect(file.owners.get('alex')).toEqual([`${CAR} Alex`])
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
// Review round: a directory (or otherwise unreadable file) at owners.yaml's
// path must fail with a clear INVALID_ARGS naming the path, not an
// unhandled EISDIR/EACCES exception.
it('loadOwnersFile throws INVALID_ARGS naming the path when owners.yaml is a directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zm-owners-'))
  mkdirSync(ownersFilePath(dir))
  expect(() => loadOwnersFile(dir)).toThrow(expect.objectContaining({ code: 'INVALID_ARGS', message: expect.stringContaining(ownersFilePath(dir)) }))
})

it('matchOwners: matches by exact account id', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Some Card')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["acc-1"]\n', 'owners.yaml')
  expect([...matchOwners(accounts, file).ownerOf]).toEqual([['acc-1', 'alex']])
})
it('matchOwners: matches by case-insensitive, trimmed title substring', () => {
  const accounts = new Map([['acc-1', account('acc-1', '  Card Alex  ')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["card alex"]\n', 'owners.yaml')
  expect([...matchOwners(accounts, file).ownerOf]).toEqual([['acc-1', 'alex']])
})
it('matchOwners: a blank (whitespace-only) entry matches nothing, rather than every account', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Some Card')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["   "]\n', 'owners.yaml')
  expect(matchOwners(accounts, file).ownerOf.size).toBe(0)
})
it('matchOwners: an account matched by no entry is left out (unassigned)', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Nothing Matches')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["Card Alex"]\n', 'owners.yaml')
  expect(matchOwners(accounts, file).ownerOf.size).toBe(0)
})
it('matchOwners: an account matched by two different owners (non-archived) is a conflict error naming both, with a pin-by-id hint pointing to zm owners', () => {
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
    // Review round follow-up item 1: `zm owners` is the diagnostic tool that
    // handles this without failing (see the 'collect' conflictMode tests
    // below) — every other command's hint now points there.
    expect(e.hint).toBe('pin it to one owner by account id; run zm owners to see all conflicts')
  }
})
// Review round follow-up item 1: `zm owners` passes conflictMode: 'collect'
// so it can report a non-archived conflict as data instead of failing —
// it's the diagnostic tool the default 'throw' mode's hint points to.
it('matchOwners with conflictMode "collect": a non-archived conflict does not throw, is listed in conflicts, left unassigned, and warned about', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Shared Card')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["Shared"]\n  sam:\n    accounts: ["Card"]\n', 'owners.yaml')
  const { ownerOf, warnings, conflicts } = matchOwners(accounts, file, 'collect')
  expect(ownerOf.has('acc-1')).toBe(false)
  expect(conflicts).toEqual([{ id: 'acc-1', title: 'Shared Card', owners: ['alex', 'sam'] }])
  expect(warnings.some(w => w.includes('Shared Card') && w.includes('acc-1'))).toBe(true)
})
it('matchOwners with conflictMode "collect": an archived conflict still behaves as before (warning, unassigned, empty conflicts)', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Shared Card', { archive: true })]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["Shared"]\n  sam:\n    accounts: ["Card"]\n', 'owners.yaml')
  const { ownerOf, warnings, conflicts } = matchOwners(accounts, file, 'collect')
  expect(ownerOf.has('acc-1')).toBe(false)
  expect(conflicts).toEqual([])
  expect(warnings).toEqual(['account "Shared Card" (acc-1) matches owners alex and sam; treated as unassigned'])
})
// The default (no third argument) stays 'throw', unchanged — every existing
// caller (loadDataset for every command except `zm owners`) keeps failing
// hard on a non-archived conflict.
it('matchOwners defaults to conflictMode "throw" with no third argument', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Shared Card')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["Shared"]\n  sam:\n    accounts: ["Card"]\n', 'owners.yaml')
  expect(() => matchOwners(accounts, file)).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
})
it('matchOwners: two entries of the SAME owner both matching the same account is not a conflict', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Card Alex')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["acc-1", "Card"]\n', 'owners.yaml')
  expect([...matchOwners(accounts, file).ownerOf]).toEqual([['acc-1', 'alex']])
})
// Review round item 2: an exact account-id entry wins over another owner's
// mere substring match — no conflict in that case.
it('matchOwners: an exact account-id entry wins over a different owner\'s substring match (no conflict)', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Shared Family Card')]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["acc-1"]\n  sam:\n    accounts: ["Family"]\n', 'owners.yaml')
  const { ownerOf, warnings } = matchOwners(accounts, file)
  expect([...ownerOf]).toEqual([['acc-1', 'alex']])
  expect(warnings).toEqual([])
})
// Review round item 2: a conflict on an ARCHIVED-only account must not
// break the command — it's resolved as unassigned, with a warning, instead
// of throwing.
it('matchOwners: a conflict on an archived account is a warning, not an error, and leaves it unassigned', () => {
  const accounts = new Map([['acc-1', account('acc-1', 'Shared Card', { archive: true })]])
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: ["Shared"]\n  sam:\n    accounts: ["Card"]\n', 'owners.yaml')
  const { ownerOf, warnings } = matchOwners(accounts, file)
  expect(ownerOf.has('acc-1')).toBe(false)
  expect(warnings).toEqual(['account "Shared Card" (acc-1) matches owners alex and sam; treated as unassigned'])
})

// --- Emoji/symbol matching (review round item 1) ---
// Entries with no letters or digits at all must align to whole
// grapheme-cluster boundaries in the title, using Intl.Segmenter — a plain
// substring match on code points would happily match a fragment of a
// larger cluster (e.g. the base emoji of a ZWJ sequence). U+FE0F (variation
// selector-16) is stripped from both sides first, after NFC normalization.
it('emoji entry: matches a title after normalizing NFC and stripping U+FE0F on both sides', () => {
  const withVs16 = new Map([['acc-1', account('acc-1', `${HEART}${FE0F} Card`)]])
  const withoutVs16 = new Map([['acc-2', account('acc-2', `${HEART} Card`)]])
  const fileWithVs16Entry = parseOwnersFile(`owners:\n  alex:\n    accounts: ["${HEART}${FE0F}"]\n`, 'owners.yaml')
  const fileWithoutVs16Entry = parseOwnersFile(`owners:\n  alex:\n    accounts: ["${HEART}"]\n`, 'owners.yaml')
  // FE0F on the title only
  expect(matchOwners(withVs16, fileWithoutVs16Entry).ownerOf.get('acc-1')).toBe('alex')
  // FE0F on the entry only
  expect(matchOwners(withoutVs16, fileWithVs16Entry).ownerOf.get('acc-2')).toBe('alex')
  // FE0F on both
  expect(matchOwners(withVs16, fileWithVs16Entry).ownerOf.get('acc-1')).toBe('alex')
  // FE0F on neither
  expect(matchOwners(withoutVs16, fileWithoutVs16Entry).ownerOf.get('acc-2')).toBe('alex')
})
it('emoji entry: a bare base emoji does NOT match inside a larger ZWJ grapheme cluster in the title', () => {
  const accounts = new Map([['acc-1', account('acc-1', `${FAMILY} Joint`)]])
  const file = parseOwnersFile(`owners:\n  alex:\n    accounts: ["${MAN}"]\n`, 'owners.yaml')
  expect(matchOwners(accounts, file).ownerOf.size).toBe(0)
})
it('emoji entry: the full ZWJ+skin-tone grapheme cluster matches, with or without a trailing U+FE0F', () => {
  const accounts = new Map([['acc-1', account('acc-1', `${MERMAID_LIGHT_FEMALE} Mermaid`)]])
  const fileFullSequence = parseOwnersFile(`owners:\n  alex:\n    accounts: ["${MERMAID_LIGHT_FEMALE}"]\n`, 'owners.yaml')
  const withoutFe0f = MERMAID_LIGHT_FEMALE.replace(FE0F, '')
  const fileWithoutFe0f = parseOwnersFile(`owners:\n  alex:\n    accounts: ["${withoutFe0f}"]\n`, 'owners.yaml')
  expect(matchOwners(accounts, fileFullSequence).ownerOf.get('acc-1')).toBe('alex')
  expect(matchOwners(accounts, fileWithoutFe0f).ownerOf.get('acc-1')).toBe('alex')
})
it('emoji entry: the bare base emoji does NOT match when it is only part of a larger grapheme cluster (skin tone + ZWJ)', () => {
  const accounts = new Map([['acc-1', account('acc-1', `${MERMAID_LIGHT_FEMALE} Mermaid`)]])
  const file = parseOwnersFile(`owners:\n  alex:\n    accounts: ["${MERMAID}"]\n`, 'owners.yaml')
  expect(matchOwners(accounts, file).ownerOf.size).toBe(0)
})
it('entries containing letters/digits keep plain case-insensitive substring matching, even alongside emoji', () => {
  const accounts = new Map([['acc-1', account('acc-1', `${CAR} Alex`)]])
  const file = parseOwnersFile(`owners:\n  alex:\n    accounts: ["${CAR} alex"]\n`, 'owners.yaml')
  expect(matchOwners(accounts, file).ownerOf.get('acc-1')).toBe('alex')
})

// An entry consisting only of a variation selector (no base character at
// all) has zero letters/digits (goes down the grapheme-matching path), but
// stripping U+FE0F from it during normalization leaves an empty grapheme
// sequence — which must match nothing, not every account.
it('entryMatchesAccount: an entry that is only a variation selector (no base character) matches nothing', () => {
  expect(entryMatchesAccount(FE0F, account('acc-1', 'Some Card'))).toBe(false)
})

// entryMatchesAccount is the per-entry primitive `zm owners` uses to warn
// about entries matching zero (or implausibly many) accounts.
it('entryMatchesAccount exposes the same matching rule matchOwners uses internally', () => {
  expect(entryMatchesAccount('acc-1', account('acc-1', 'Some Card'))).toBe(true)
  expect(entryMatchesAccount('card', account('acc-1', 'Some Card'))).toBe(true)
  expect(entryMatchesAccount('nope', account('acc-1', 'Some Card'))).toBe(false)
  expect(entryMatchesAccount(HEART, account('acc-1', `${HEART}${FE0F} Card`))).toBe(true)
})

// --- Keycap emoji classification (review round follow-up item 8) ---
// A keycap sequence (digit/#/* + optional U+FE0F + U+20E3) contains a
// letter/digit code point, but the whole sequence reads as one emoji
// character, not text — it must be classified (and matched) as a
// symbol/grapheme entry, not a substring-matched text entry.
it('letterOrDigitCount ignores a digit that is only part of a keycap sequence', () => {
  expect(letterOrDigitCount(KEYCAP_ONE)).toBe(0)
  expect(letterOrDigitCount('1')).toBe(1) // a bare digit (no keycap mark) still counts
  expect(letterOrDigitCount(`a${KEYCAP_ONE}`)).toBe(1) // a real letter alongside a keycap still counts
})
it('a keycap entry is matched by whole-grapheme alignment, not as a substring text match', () => {
  const withKeycap = new Map([['acc-1', account('acc-1', `${KEYCAP_ONE} Card`)]])
  const file = parseOwnersFile(`owners:\n  alex:\n    accounts: ["${KEYCAP_ONE}"]\n`, 'owners.yaml')
  expect(matchOwners(withKeycap, file).ownerOf.get('acc-1')).toBe('alex')
  // A title with only the bare digit (no keycap marks at all) is a
  // DIFFERENT grapheme cluster ("1" alone vs. the full keycap cluster) — if
  // the keycap entry were instead treated as text and substring-matched,
  // this would incorrectly match too.
  const withBareDigit = new Map([['acc-2', account('acc-2', '1 Card')]])
  expect(matchOwners(withBareDigit, file).ownerOf.size).toBe(0)
})

// --- Lazy Intl.Segmenter (review round follow-up item 7) ---
// Intl.Segmenter is only ever constructed when an emoji/symbol entry is
// actually matched — a plain text-only owners.yaml must keep working even
// on a Node build that lacks it (e.g. a small-ICU build), and a clear
// ZmError, not a raw exception, must surface when it's genuinely needed
// and unavailable.
it('a text-only entry never touches Intl.Segmenter, even if it would throw', () => {
  const original = Intl.Segmenter
  ;(Intl as any).Segmenter = function () { throw new Error('no full-ICU Intl.Segmenter') }
  try {
    expect(entryMatchesAccount('Card', account('acc-1', 'Some Card'))).toBe(true)
  } finally {
    (Intl as any).Segmenter = original
  }
})
it('throws a clear UNEXPECTED ZmError when Intl.Segmenter is unavailable and an emoji entry is actually matched', () => {
  const original = Intl.Segmenter
  ;(Intl as any).Segmenter = function () { throw new Error('no full-ICU Intl.Segmenter') }
  try {
    expect(() => entryMatchesAccount(HEART, account('acc-1', 'Some Card'))).toThrow(
      expect.objectContaining({
        code: 'UNEXPECTED',
        message: 'this Node build lacks Intl.Segmenter (full ICU required) for emoji owner entries',
      }),
    )
  } finally {
    (Intl as any).Segmenter = original
  }
})
