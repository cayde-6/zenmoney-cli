import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Command } from 'commander'
import type { AppContext } from '../context.js'
import { formatOf, readVersion } from '../program.js'
import { printResult } from '../output.js'
import { tokenSource } from '../../auth/token.js'
import { round1 } from '../../util.js'

interface CacheInfo { path: string; exists: boolean; readable: boolean; lastSyncAt: string | null; ageHours: number | null; error?: string }

// Short: `zm status` is a diagnostic command someone runs while something
// else is wrong, not a long-lived server process — waiting out a real,
// stuck lock for the full 5s Store.open() waits for read commands would
// make status itself look hung. Long enough to ride out a brief, genuinely
// transient lock (e.g. a `zm sync` mid-write).
const STATUS_BUSY_TIMEOUT_MS = 1000

function readLastSyncAt(db: DatabaseSync): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'lastSyncAt'`).get() as { value: string } | undefined
  return row ? row.value : null
}

function walPath(path: string): string { return `${path}-wal` }

// Whether `-wal` exists at all (not just whether it's non-empty): a cache
// that was cleanly closed has no `-wal` file at all (SQLite fully
// checkpoints and removes it on close) — its mere presence already means
// something hasn't cleanly checkpointed, either a crash or an active
// writer. Checking size alone isn't reliable here: empirically, a
// connection that holds `PRAGMA locking_mode=EXCLUSIVE` (as a real
// concurrent `zm sync` would while writing) can leave `-wal` at 0 bytes for
// the whole duration of an in-progress transaction, only growing it (or
// not, if it fits in memory) around commit/checkpoint — so a 0-byte `-wal`
// is not proof there's nothing pending.
function walExists(path: string): boolean {
  return existsSync(walPath(path))
}

// A URI filename with `mode=ro&immutable=1` reads the database without ever
// creating the `-wal`/`-shm` sidecar files a normal WAL-mode connection
// needs even just to read (confirmed empirically on the Node version this
// was written against; `readOnly`/URI-filename support are both plain
// SQLite C API / node:sqlite capabilities present since `readOnly` itself
// shipped, well within this project's Node >= 22.13 requirement — the
// try/catch below falls back to approach (b) regardless if that ever turns
// out wrong on some runtime). `immutable` tells SQLite the file will never
// change, which also means a directory that's read-only (so a normal
// connection can't create its `-shm` index) is no obstacle here.
//
// The tradeoff: an immutable connection never looks at `-wal` at all, so any
// not-yet-checkpointed data in it is invisible — for an absent `-wal` this
// is a no-op (nothing to miss), but with real pending data it can return
// stale values or even "no such table" if the schema itself hasn't been
// checkpointed yet. Only attempted when `-wal` doesn't exist at all;
// `readCacheInfo` below falls back to approach (b) otherwise.
function tryImmutableRead(path: string): { lastSyncAt: string | null } | { error: string } | null {
  // encodeURI leaves `?`/`#` unescaped (they're valid URI characters), but a
  // real file path could itself contain one, corrupting the query-string/
  // fragment boundary — escape those two explicitly on top of encodeURI.
  const escaped = encodeURI(path).replace(/[?#]/g, c => encodeURIComponent(c))
  const uri = `file:${escaped}?mode=ro&immutable=1`
  let db: DatabaseSync
  try {
    db = new DatabaseSync(uri, { readOnly: true })
  } catch {
    // Opening the URI itself failed — most plausibly URI filenames aren't
    // supported in this environment the way expected. Let the caller fall
    // back to a plain (non-URI) read-only open instead of reporting failure
    // from what may just be this approach's own limitation.
    return null
  }
  try {
    return { lastSyncAt: readLastSyncAt(db) }
  } catch (e) {
    // The connection to the real file was established fine (proving URI
    // parsing works) — a failure here is a genuine data problem, not this
    // approach's fault, so it's reported as-is rather than retried via (b).
    return { error: (e as Error).message }
  } finally {
    db.close()
  }
}

// Approach (b): a plain read-only open. Unlike the URI/immutable approach,
// this fully participates in SQLite's normal locking (so `busy_timeout`
// actually matters) and sees uncommitted WAL data correctly — but, for a
// WAL-mode database, still needs to create `-shm` (and can create `-wal`)
// as a side effect of merely opening it, even read-only.
//
// This deliberately does NOT delete any `-wal`/`-shm` sidecar file it
// creates: another process (e.g. a concurrent `zm sync`) could start
// relying on that same sidecar the instant after this connection closes,
// and deleting out from under it risks corrupting its view of the
// database. Leaving the sidecar behind is harmless — SQLite recreates/
// reuses it as needed — so this path only ever adds files next to the
// cache, never removes them, and never touches the database's own
// contents. See README.md's Privacy/status section and docs/architecture.md
// for where this is documented.
function readViaNormalReadOnly(path: string, now: () => Date): CacheInfo {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (e) {
    return { path, exists: true, readable: false, lastSyncAt: null, ageHours: null, error: (e as Error).message }
  }
  try {
    db.exec(`PRAGMA busy_timeout=${STATUS_BUSY_TIMEOUT_MS}`)
    const lastSyncAt = readLastSyncAt(db)
    const ageHours = lastSyncAt === null ? null : round1((now().getTime() - new Date(lastSyncAt).getTime()) / (1000 * 60 * 60))
    return { path, exists: true, readable: true, lastSyncAt, ageHours }
  } catch (e) {
    return { path, exists: true, readable: false, lastSyncAt: null, ageHours: null, error: (e as Error).message }
  } finally {
    db.close()
  }
}

// `zm status` must never mutate the cache (unlike Store.open, which
// mkdirs/switches to WAL/migrates/chmods by design for every other
// command): tries the no-side-effect immutable read first, whenever it's
// safe to (see tryImmutableRead), and only falls back to a plain read-only
// open — which can need to create, and then best-effort removes, `-wal`/
// `-shm` — when there's real pending WAL data an immutable read would miss,
// or the immutable approach itself doesn't pan out.
function readCacheInfo(path: string, now: () => Date): CacheInfo {
  if (!existsSync(path)) {
    return { path, exists: false, readable: false, lastSyncAt: null, ageHours: null }
  }

  if (!walExists(path)) {
    const result = tryImmutableRead(path)
    if (result !== null) {
      if ('error' in result) return { path, exists: true, readable: false, lastSyncAt: null, ageHours: null, error: result.error }
      const { lastSyncAt } = result
      const ageHours = lastSyncAt === null ? null : round1((now().getTime() - new Date(lastSyncAt).getTime()) / (1000 * 60 * 60))
      return { path, exists: true, readable: true, lastSyncAt, ageHours }
    }
  }

  return readViaNormalReadOnly(path, now)
}

// `zm status` is deliberately the one command that always works: no network
// call, no token required, and it must not fail — or mutate anything, cache
// included — just because nothing has been set up yet. It exists to answer
// "why doesn't zm work" without anything else having to work first.
export function registerStatus(program: Command, ctx: AppContext): void {
  program.command('status')
    .description('Show cache/token/config state (no network call, works without a token or cache; never intentionally modifies the cache)')
    .addHelpText('after', '\nExamples:\n  zm status\n')
    .action((_opts, cmd) => {
      const format = formatOf(cmd)
      const cache = readCacheInfo(ctx.paths.cacheDb, ctx.now)

      // Only *where* a token would come from, never its value.
      const source = tokenSource({ env: ctx.env, keychain: ctx.keychain, configFile: ctx.paths.configFile })

      const data = {
        cache,
        token: { source },
        configDir: ctx.paths.configDir,
        budgetDir: ctx.paths.budgetDir,
        version: readVersion(),
      }
      printResult({ data, meta: {} }, format, ctx.stdout)
    })
}
