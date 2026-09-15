import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Review round item 13: a manual `node dist/bin.js status` invocation during
// development (with no XDG_CONFIG_HOME/XDG_CACHE_HOME override) created an
// empty ~/.cache/zm/zm.sqlite in the real home directory on this machine —
// Store.open() creates the cache dir/file as a side effect of merely
// opening it. Every actual automated test already builds its own isolated
// temp paths explicitly (tests/helpers.ts's testContext/seededContext pass
// an explicit `home` to resolvePaths; tests/e2e/bin.test.ts's spawned
// processes pass explicit XDG_CONFIG_HOME/XDG_CACHE_HOME in `env`) and so
// were never actually at risk — only an ad hoc manual shell command was.
// This is defense in depth regardless: for the whole vitest run (all worker
// processes, which inherit process.env from this main process), force
// HOME/USERPROFILE/XDG_CONFIG_HOME/XDG_CACHE_HOME to a private temp
// directory, so no test — now or added later — can ever fall back to
// touching the real home even if it forgets to pass its own explicit paths.
export default function setup(): void {
  const home = mkdtempSync(join(tmpdir(), 'zm-vitest-home-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.XDG_CACHE_HOME = join(home, '.cache')
  // Follow-up round item 4: paths.ts's win32 branch reads APPDATA/
  // LOCALAPPDATA instead of XDG_*_HOME — pin those too, so a test that
  // somehow exercises the win32 path (or a real Windows CI run of this
  // suite) can't touch the real home either.
  process.env.APPDATA = join(home, 'AppData', 'Roaming')
  process.env.LOCALAPPDATA = join(home, 'AppData', 'Local')
}
