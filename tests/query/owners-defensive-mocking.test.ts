import { it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolated in its own file (like tests/auth/token-atomic-write.test.ts, for
// the same reason) because it mocks 'yaml' and 'node:fs' for the whole
// module graph it imports — mixing that with owners.test.ts's many tests
// that rely on real yaml/fs behavior would make nearly all of them fail too.
//
// query/owners.ts's parseOwnersFile/loadOwnersFile each contain a defensive
// `e instanceof Error ? e.message : String(e)` fallback, and
// nonStringOwnerKeys (parseOwnersFile's internal re-parse via parseDocument,
// used only to catch a non-string "owners" key) has its own defensive
// catch/isMap/continue paths. None of these are reachable with real yaml
// text or a real filesystem error: the 'yaml' package's own parse() is
// strictly more likely to throw (and always throws a real Error) than
// parseDocument() on the same text, and Node's fs errors are always Error
// instances too. Mocking the dependencies is the only way to exercise them.
vi.mock('yaml', async () => {
  const actual = await vi.importActual<typeof import('yaml')>('yaml')
  return { ...actual, parse: vi.fn(actual.parse), parseDocument: vi.fn(actual.parseDocument) }
})
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

afterEach(() => { vi.restoreAllMocks() })

it('parseOwnersFile stringifies a thrown non-Error value from yaml\'s parse()', async () => {
  const YAML = await import('yaml')
  vi.mocked(YAML.parse).mockImplementationOnce(() => { throw 'not an Error instance' })
  const { parseOwnersFile } = await import('../../src/query/owners.js')
  expect(() => parseOwnersFile('owners: {}\n', 'owners.yaml')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'owners.yaml: invalid yaml: not an Error instance' }),
  )
})

it('parseOwnersFile still succeeds when yaml\'s internal parseDocument() throws while scanning for non-string owner keys', async () => {
  const YAML = await import('yaml')
  vi.mocked(YAML.parseDocument).mockImplementationOnce(() => { throw new Error('boom') })
  const { parseOwnersFile } = await import('../../src/query/owners.js')
  // parse() itself still succeeds on this well-formed text — the internal
  // re-parse (only used to catch a non-string "owners" key) throwing is
  // swallowed rather than surfacing as a crash.
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: [a]\n', 'owners.yaml')
  expect([...file.owners]).toEqual([['alex', ['a']]])
})

it('parseOwnersFile tolerates a stubbed parseDocument() whose document root is not a map', async () => {
  const YAML = await import('yaml')
  vi.mocked(YAML.parseDocument).mockImplementationOnce(() => ({ contents: {} }) as any)
  const { parseOwnersFile } = await import('../../src/query/owners.js')
  const file = parseOwnersFile('owners:\n  alex:\n    accounts: [a]\n', 'owners.yaml')
  expect([...file.owners]).toEqual([['alex', ['a']]])
})

// nonStringOwnerKeys's key-name check (`pair.key.value === 'owners'`, see
// owners.ts) must skip a non-"owners" top-level pair entirely, rather than
// also scanning ITS sub-keys for non-string ones. A stubbed parseDocument()
// stands in for a document containing a foreign "extra" top-level block
// (parseOwnersFile's own real-`parse()`-based "unknown key" check would
// otherwise reject "extra" outright, before nonStringOwnerKeys ever runs —
// so the only way to reach this code path at all is to make parseDocument's
// view of the text differ from parse()'s, exactly as the file's other
// stubbed-parseDocument tests above do). "extra" has a bare (unquoted)
// `true:` key, which parses as the boolean `true`; the real "owners" block
// separately has a legitimately quoted `"true":` OWNER. Removing the
// key-name check would make nonStringOwnerKeys also scan "extra" and add
// the string "true" to its result — wrongly rejecting that unrelated,
// correctly-quoted owner.
it('parseOwnersFile does not let a non-"owners" top-level block\'s non-string key reject an unrelated, correctly-quoted owner name', async () => {
  const YAML = await import('yaml')
  const actual = await vi.importActual<typeof import('yaml')>('yaml')
  const text = 'owners:\n  "true":\n    accounts: [a]\n'
  const fakeDoc = actual.parseDocument('owners:\n  "true":\n    accounts: [a]\nextra:\n  true: x\n')
  vi.mocked(YAML.parseDocument).mockImplementationOnce(() => fakeDoc as any)
  const { parseOwnersFile } = await import('../../src/query/owners.js')
  const file = parseOwnersFile(text, 'owners.yaml')
  expect([...file.owners]).toEqual([['true', ['a']]])
})

it('loadOwnersFile stringifies a thrown non-Error value from readFileSync', async () => {
  const fs = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'zm-owners-mock-'))
  const file = join(dir, 'owners.yaml')
  writeFileSync(file, 'owners:\n  alex:\n    accounts: [a]\n')
  vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw 'not an Error instance' })
  const { loadOwnersFile } = await import('../../src/query/owners.js')
  expect(() => loadOwnersFile(dir)).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: `${file}: cannot read owners.yaml: not an Error instance` }),
  )
})
