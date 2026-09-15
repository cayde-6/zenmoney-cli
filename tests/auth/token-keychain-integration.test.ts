import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { macKeychain, type ExecFn } from '../../src/auth/token.js'

// Opt-in integration test: exercises a REAL `security` round-trip against the
// real macOS Keychain, unlike every other test in this repo (which uses a fake
// ExecFn/Keychain and never touches the real Keychain). Guarded so it never
// runs by accident:
//   - only on darwin (macKeychain shells out to the `security` binary)
//   - only when ZM_KEYCHAIN_IT=1 is set explicitly
// It uses a throwaway service name distinct from the real 'zenmoney-cli' one
// (macKeychain's second, injectable parameter), so it can never read,
// overwrite, or remove the actual token a developer or CI machine has stored
// under the real service name. The dummy entry is always removed in a
// `finally`, even if an assertion fails.
//
// Run locally with: ZM_KEYCHAIN_IT=1 npx vitest run tests/auth/token-keychain-integration.test.ts
const enabled = process.platform === 'darwin' && process.env.ZM_KEYCHAIN_IT === '1'

// tests/global-setup.ts forces HOME to a private temp dir for the whole
// vitest run (so no other test can ever touch a real keychain by accident).
// `security` resolves the login keychain from HOME, so with the fake HOME it
// can't find one and fails outright ("authorization was canceled") instead of
// running the round-trip below. This test alone restores the real HOME
// (stashed by global-setup as ZM_REAL_HOME) for its own `security` calls only.
const execWithRealHome: ExecFn = (file, args, input) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    input,
    env: { ...process.env, HOME: process.env.ZM_REAL_HOME },
  })

describe.runIf(enabled)('macKeychain (real macOS Keychain integration)', () => {
  it('sets, gets, and removes a dummy value under a throwaway service name', () => {
    const service = `zenmoney-cli-it-${randomBytes(6).toString('hex')}`
    const keychain = macKeychain(execWithRealHome, service)
    try {
      expect(keychain.get()).toBeNull()
      keychain.set('dummy-integration-token')
      expect(keychain.get()).toBe('dummy-integration-token')
    } finally {
      keychain.remove()
    }
    expect(keychain.get()).toBeNull()
  })
})
