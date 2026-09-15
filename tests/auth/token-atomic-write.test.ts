import { it, expect, vi, beforeEach, afterEach } from 'vitest'

// Isolated in its own file (rather than tests/auth/token.test.ts) because it
// mocks node:fs for the whole module graph this file imports — mixing that
// with token.test.ts's many tests that rely on real fs behavior for
// saveToken/removeToken would make nearly all of them fail too.
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  }
})

// Review round follow-up item 3: these three mocks are created once (the
// vi.mock factory above runs once for this whole file), so their call
// history persists across `it()` blocks unless explicitly cleared. Relying
// on `vi.restoreAllMocks()` alone here is fragile — whether it actually
// resets call history for a `vi.fn()` that wasn't created via `vi.spyOn`
// depends on the vitest version, which is exactly how the second test below
// could pass on a leaked call from the first one instead of its own. Clear
// explicitly, every time, regardless of that.
beforeEach(async () => {
  const fs = await import('node:fs')
  vi.mocked(fs.writeFileSync).mockClear()
  vi.mocked(fs.renameSync).mockClear()
  vi.mocked(fs.unlinkSync).mockClear()
})
afterEach(() => { vi.restoreAllMocks() })

// Review round item 7: writeConfig's temp-file-then-rename must clean up the
// temp file if either step fails, rather than leaving an orphaned
// `.config.json.<pid>.<rand>.tmp` file behind in the config dir forever.
it('removes the temp file when renameSync fails', async () => {
  const fs = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = actualFs.mkdtempSync(join(tmpdir(), 'zm-atomic-'))
  const configFile = join(dir, 'zm', 'config.json')

  vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('simulated rename failure') })

  const { saveToken } = await import('../../src/auth/token.js')
  expect(() => saveToken('abc', { env: {}, keychain: null, configFile })).toThrow('simulated rename failure')

  // writeFileSync was called with a temp path (same dir, not the final file)...
  const writeCalls = vi.mocked(fs.writeFileSync).mock.calls
  expect(writeCalls).toHaveLength(1)
  const tmpPath = String(writeCalls[0]![0])
  expect(tmpPath).not.toBe(configFile)
  expect(tmpPath.startsWith(join(dir, 'zm'))).toBe(true)

  // ...and unlinkSync was called to clean it up after the rename failed.
  expect(fs.unlinkSync).toHaveBeenCalledWith(tmpPath)
  // No leftover temp (or real config) file on disk.
  expect(actualFs.existsSync(tmpPath)).toBe(false)
  expect(actualFs.existsSync(configFile)).toBe(false)
})

it('removes the temp file when writeFileSync itself fails', async () => {
  const fs = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = actualFs.mkdtempSync(join(tmpdir(), 'zm-atomic-'))
  const configFile = join(dir, 'zm', 'config.json')

  vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error('simulated write failure') })

  const { saveToken } = await import('../../src/auth/token.js')
  expect(() => saveToken('abc', { env: {}, keychain: null, configFile })).toThrow('simulated write failure')

  // writeFileSync still recorded the temp path it was called with, even
  // though it threw instead of returning.
  const writeCalls = vi.mocked(fs.writeFileSync).mock.calls
  expect(writeCalls).toHaveLength(1)
  const tmpPath = String(writeCalls[0]![0])
  expect(tmpPath).not.toBe(configFile)

  // The cleanup path still runs — unlinkSync targets that exact temp path
  // (a safe no-op, since nothing was actually written there).
  expect(fs.unlinkSync).toHaveBeenCalledTimes(1)
  expect(fs.unlinkSync).toHaveBeenCalledWith(tmpPath)
  expect(actualFs.existsSync(configFile)).toBe(false)
})
