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
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 90,
      },
    },
  },
})
