import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Command } from 'commander'
import type { AppContext } from '../context.js'
import { formatOf, readVersion } from '../program.js'
import { printResult } from '../output.js'
import { tokenSource } from '../../auth/token.js'
import { round1 } from '../../util.js'

interface CacheInfo { path: string; exists: boolean; readable: boolean; lastSyncAt: string | null; ageHours: number | null; error?: string }

function readLastSyncAt(db: DatabaseSync): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'lastSyncAt'`).get() as { value: string } | undefined
  return row ? row.value : null
}

function walPath(path: string): string { return `${path}-wal` }

// `zm status` must never write to the real cache file or its directory, and
// must behave the same on every Node version this project supports — an
// earlier version of this code tried a `mode=ro&immutable=1` URI filename
// first, but URI-filename support in `node:sqlite` turned out to vary by
// Node version (confirmed broken on 22.13.0, working on 22 latest/24),
// making that approach unreliable as the only no-side-effect path.
//
// Instead, this copies the cache file (and its `-wal` file, if one exists —
// never `-shm`, see below) into a private temp directory, then opens that
// COPY with a normal, non-read-only `DatabaseSync`. Opening the copy
// normally (rather than read-only) lets SQLite replay the `-wal` file into
// it, so committed-but-not-yet-checkpointed data is included, not just
// whatever's in the base file — but only committed data: a transaction
// that's in flight (BEGIN'd but not COMMIT'd) at the exact moment of the
// copy has no valid commit frame in the copied `-wal`, and SQLite simply
// ignores it on open, same as any other reader would. Any file this
// approach creates or modifies lives entirely inside the temp directory,
// which is always removed afterwards — the real cache file and its
// directory are only ever read from (`copyFileSync`), never written to.
//
// `-shm` (the shared-memory WAL index) is deliberately never copied: it's
// meaningless outside the process that memory-maps it, and SQLite rebuilds
// it from scratch the moment it opens the copied files anyway.
function readCacheInfo(path: string, now: () => Date): CacheInfo {
  if (!existsSync(path)) {
    return { path, exists: false, readable: false, lastSyncAt: null, ageHours: null }
  }

  let tempDir: string | null = null
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'zm-status-'))
    const copyPath = join(tempDir, basename(path))
    copyFileSync(path, copyPath)
    if (existsSync(walPath(path))) {
      copyFileSync(walPath(path), walPath(copyPath))
    }

    const db = new DatabaseSync(copyPath, { readOnly: false })
    try {
      const lastSyncAt = readLastSyncAt(db)
      const ageHours = lastSyncAt === null ? null : round1((now().getTime() - new Date(lastSyncAt).getTime()) / (1000 * 60 * 60))
      return { path, exists: true, readable: true, lastSyncAt, ageHours }
    } finally {
      db.close()
    }
  } catch (e) {
    // Anything that can go wrong here (permission denied copying the source,
    // not a database, corrupted file, bad JSON never applies here since this
    // only reads `meta`) is reported as `readable: false`, never thrown —
    // `zm status` is a diagnostic that must always return something.
    return { path, exists: true, readable: false, lastSyncAt: null, ageHours: null, error: (e as Error).message }
  } finally {
    if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true })
  }
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
