import { mkdirSync, chmodSync, existsSync } from 'node:fs'

// Every chmod in this module is skipped entirely on win32: Windows has no
// POSIX permission bits, and forcing one risks throwing on filesystems/CI
// runners that don't support it the way POSIX chmod does. mkdir itself still
// runs everywhere (`mode` there is also POSIX-only and ignored by Node on
// win32, which is fine — it's the explicit chmod that needs to be skipped).

// Creates `dir` (and parents) if missing, then chmods it to `mode` — used for
// the config/cache/budget dirs, which must not be group/world-readable since
// they can hold a token or financial data.
export function ensureDirMode(dir: string, mode: number, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(dir, { recursive: true })
  if (platform !== 'win32') chmodSync(dir, mode)
}

// Chmods an existing file to `mode`, silently doing nothing if it doesn't
// exist (e.g. `<db>-wal`/`<db>-shm`, which only exist once WAL mode has
// actually written to them) or on win32.
export function chmodIfExists(path: string, mode: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return
  if (!existsSync(path)) return
  chmodSync(path, mode)
}
