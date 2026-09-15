import { constants as fsConstants, existsSync, mkdtempSync, copyFileSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs'
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

// A snapshot copy is retried this many times before giving up and reporting
// `readable: false` — see `readCacheInfo` below for why a retry is ever
// needed at all.
const MAX_SNAPSHOT_ATTEMPTS = 3

function readLastSyncAt(db: DatabaseSync): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'lastSyncAt'`).get() as { value: string } | undefined
  return row ? row.value : null
}

function walPath(path: string): string { return `${path}-wal` }

// The WAL header's first 32 bytes (magic, format version, page size,
// checkpoint sequence, and both salts) change every time a writer resets or
// checkpoints the file — enough to detect "the `-wal` changed" without
// reading the whole (potentially large, actively-growing) file. `null`
// means no `-wal` exists (including "disappeared while we were reading
// it", e.g. a writer just checkpointed and removed it) — that's a real,
// meaningful state to compare, not an error.
function readWalHeader(path: string): Buffer | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    const buf = Buffer.alloc(32)
    const bytesRead = readSync(fd, buf, 0, 32, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

interface FileSnapshot { size: number; mtimeMs: number; walHeader: Buffer | null }

function statSnapshot(path: string): FileSnapshot {
  const st = statSync(path)
  return { size: st.size, mtimeMs: st.mtimeMs, walHeader: readWalHeader(walPath(path)) }
}

function snapshotsMatch(a: FileSnapshot, b: FileSnapshot): boolean {
  if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) return false
  if ((a.walHeader === null) !== (b.walHeader === null)) return false
  if (a.walHeader !== null && b.walHeader !== null && !a.walHeader.equals(b.walHeader)) return false
  return true
}

// `ENOSPC`/`EACCES` writing into OUR OWN temp directory (full disk, some
// unusual tmpdir permission setup) is an environment problem, not a cache
// problem — worth telling apart from "the real cache file/dir has a
// permission problem" so whoever reads the error message doesn't go
// chasing the wrong thing. `copyFileSync`'s error carries the destination
// it failed to write as `.dest` (distinct from `.path`, the source), which
// is what's checked here rather than guessing from the message text.
function isTempSideError(e: unknown, destPaths: string[]): boolean {
  const err = e as NodeJS.ErrnoException & { dest?: string }
  if (err.code !== 'ENOSPC' && err.code !== 'EACCES') return false
  return typeof err.dest === 'string' && destPaths.includes(err.dest)
}

type AttemptResult =
  | { ok: true; lastSyncAt: string | null }
  | { ok: false; retry: true }
  | { ok: false; retry: false; error: string }

// One attempt at the snapshot-and-read described on `readCacheInfo`. Always
// cleans up its own temp directory, even on failure — cleanup itself is
// best-effort (see the `finally` below) and never changes the outcome.
function attemptSnapshot(path: string): AttemptResult {
  let tempDir: string | null = null
  try {
    try {
      tempDir = mkdtempSync(join(tmpdir(), 'zm-status-'))
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      const message = (e as Error).message
      const prefixed = code === 'ENOSPC' || code === 'EACCES'
      return { ok: false, retry: false, error: prefixed ? `could not snapshot the cache: ${message}` : message }
    }

    const copyPath = join(tempDir, basename(path))
    const walCopyPath = walPath(copyPath)
    const before = statSnapshot(path)

    try {
      copyFileSync(path, copyPath, fsConstants.COPYFILE_FICLONE)
      // Only copy `-wal` when the snapshot taken just above actually saw
      // one — if it didn't, any `-wal` that shows up between here and the
      // `after` check below is caught as a mismatch there instead, without
      // a second existence check (and its own TOCTOU window) here.
      if (before.walHeader !== null) {
        copyFileSync(walPath(path), walCopyPath, fsConstants.COPYFILE_FICLONE)
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      // The `-wal` existed an instant ago (per `before`) but is gone now —
      // most likely a writer just checkpointed and removed it. That's a
      // real change to the cache mid-snapshot, not a hard failure: retry
      // with a fresh copy rather than reporting unreadable.
      if (err.code === 'ENOENT' && err.path === walPath(path)) {
        return { ok: false, retry: true }
      }
      if (isTempSideError(err, [copyPath, walCopyPath])) {
        return { ok: false, retry: false, error: `could not snapshot the cache: ${err.message}` }
      }
      throw e
    }

    // The whole point of copying `-wal` before/after is to detect a
    // checkpoint (or any other write) landing in the middle of the copy,
    // which can otherwise produce a torn, internally-inconsistent pair of
    // files that still happens to open — see the `quick_check` below for
    // the second half of that guard.
    const after = statSnapshot(path)
    if (!snapshotsMatch(before, after)) {
      return { ok: false, retry: true }
    }

    const db = new DatabaseSync(copyPath, { readOnly: false })
    try {
      const check = db.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined
      const checkResult = check?.quick_check ?? 'no result'
      if (checkResult !== 'ok') {
        return { ok: false, retry: false, error: `cache integrity check failed: ${checkResult}` }
      }
      return { ok: true, lastSyncAt: readLastSyncAt(db) }
    } finally {
      db.close()
    }
  } catch (e) {
    return { ok: false, retry: false, error: (e as Error).message }
  } finally {
    if (tempDir !== null) {
      try {
        rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {
        // Best-effort: a leftover temp dir is not the caller's problem and
        // must never turn a successful (or already-failed) read into a
        // different result.
      }
    }
  }
}

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
// approach creates or modifies lives entirely inside a temp directory that
// is always removed afterwards — the real cache file and its directory are
// only ever read from (`copyFileSync`/`statSync`), never written to.
//
// `-shm` (the shared-memory WAL index) is deliberately never copied: it's
// meaningless outside the process that memory-maps it, and SQLite rebuilds
// it from scratch the moment it opens the copied files anyway.
//
// Copying two files (db, then `-wal`) is not atomic, so a checkpoint (or
// any other write) landing between the two copies can produce a torn pair
// that's individually well-formed but mutually inconsistent — SQLite can
// even open such a pair without complaint while returning stale or
// nonsensical data. `attemptSnapshot` guards against this two ways: a
// `statSync`/`-wal`-header comparison taken immediately before and after
// the copy detects the source changing mid-copy, and `PRAGMA quick_check`
// on the resulting copy catches whatever that comparison might still miss.
// Either one failing (or the `-wal` disappearing mid-copy — see
// `attemptSnapshot`) means a retry with a fresh temp dir, up to
// `MAX_SNAPSHOT_ATTEMPTS` times, before finally reporting `readable: false`
// with a message that says to retry shortly, since at that point a writer
// is genuinely, persistently active rather than status having hit one
// unlucky moment.
function readCacheInfo(path: string, now: () => Date): CacheInfo {
  if (!existsSync(path)) {
    return { path, exists: false, readable: false, lastSyncAt: null, ageHours: null }
  }

  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt++) {
    const result = attemptSnapshot(path)
    if (result.ok) {
      const { lastSyncAt } = result
      const ageHours = lastSyncAt === null ? null : round1((now().getTime() - new Date(lastSyncAt).getTime()) / (1000 * 60 * 60))
      return { path, exists: true, readable: true, lastSyncAt, ageHours }
    }
    if (!result.retry) {
      return { path, exists: true, readable: false, lastSyncAt: null, ageHours: null, error: result.error }
    }
  }
  return { path, exists: true, readable: false, lastSyncAt: null, ageHours: null, error: 'cache is being written by another process, retry shortly' }
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
