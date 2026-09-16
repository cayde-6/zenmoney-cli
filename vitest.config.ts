import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Forces HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME to a private temp dir for
    // the whole run, so no test can ever touch the real home — see
    // tests/global-setup.ts for why.
    globalSetup: ['tests/global-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**'],
      // bin.ts is only ever exercised as a spawned subprocess (tests/e2e/bin.test.ts),
      // never imported in-process, so v8 can never attribute coverage to it here.
      exclude: ['src/bin.ts'],
      // Every line and every function in src/ is covered, so those ratchet at
      // 100 — a new uncovered one is a missing test, not a rounding error.
      // The branch/statement floors sit just below 100 because a handful of
      // defensive `?? fallback` arms are unreachable by construction (their
      // invariants are enforced by the caller), and the alternatives — an
      // ignore comment or deleting the guard — both cost more than the two
      // points do.
      thresholds: {
        lines: 100,
        statements: 99,
        functions: 100,
        branches: 98,
      },
    },
  },
})
