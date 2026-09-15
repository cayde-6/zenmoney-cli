import { constants as fsConstants, existsSync, accessSync, mkdtempSync, copyFileSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Command } from 'commander'
import type { AppContext } from '../context.js'
import { formatOf, readVersion } from '../program.js'
import { printResult } from '../output.js'
import { tokenSource } from '../../auth/token.js'
import { loadOwnersFile, ownersFilePath } from '../../query/owners.js'
import { ZmError } from '../../errors.js'
import { round1 } from '../../util.js'

interface OwnersFileInfo { path: string; exists: boolean; valid: boolean; error?: string }

// Parses owners.yaml (if any) without ever touching the cache — `zm status`
// must work with no cache at all, so this can't reuse whatever a read
// command's own Dataset already validated. `valid` is true both when the
// file doesn't exist and when it parses cleanly; only a genuine parse/read
// failure (bad yaml/shape, or an unreadable path — e.g. a directory) sets
// it false and fills in `error`.
//
// `valid` covers PARSING ONLY (loadOwnersFile: shape, name rules, yaml
// syntax) — it says nothing about whether the file's `accounts` entries
// actually match real accounts without conflict, since that requires the
// cache (matchOwners needs the real account list), which `zm status`
// deliberately never opens. A well-formed owners.yaml with a genuine
// matching conflict is still `valid: true` here; run `zm owners` to see
// conflicts (data.conflicts) and other matching problems (warnings).
function readOwnersFileInfo(configDir: string): OwnersFileInfo {
  const path = ownersFilePath(configDir)
  const exists = existsSync(path)
  try {
    loadOwnersFile(configDir)
    return { path, exists, valid: true }
  } catch (e) {
    const message = e instanceof ZmError ? e.message : e instanceof Error ? e.message : String(e)
    return { path, exists, valid: false, error: message }
  }
}

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
// meaningful state to compare, not an error. Any other failure (most
// plausibly `EACCES`) is a real problem reading the cache's own `-wal`
// file and is propagated as-is: nothing in this function ever touches the
// temp side, so — consistent with the explicit `accessSync` check in
// `attemptSnapshot` below — none of its failures get that path's
// "could not snapshot the cache: " prefix.
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

// `ENOSPC`/`EACCES` from `copyFileSync` at this point (i.e. once the source
// has already been confirmed readable via `accessSync` in `attemptSnapshot`
// below) is an environment problem on OUR OWN temp directory — a full disk,
// or some unusual tmpdir permission setup — not a cache problem, worth
// telling apart from "the real cache file/dir has a permission problem" so
// whoever reads the error message doesn't go chasing the wrong thing.
//
// This deliberately does NOT look at `copyFileSync`'s `.dest` property to
// decide: confirmed empirically, Node sets `.dest` to our destination path
// on EVERY `copyFileSync` failure, including one caused by the SOURCE being
// unreadable — so `.dest` can't actually distinguish which side failed, and
// checking it (an earlier version of this code did) risked mislabeling a
// real cache-side permission problem as a local one. The `accessSync` calls
// in `attemptSnapshot`, run before any `copyFileSync` call, are what
// actually rule out a source-side cause first.
function isLikelyTempSideError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code
  return code === 'ENOSPC' || code === 'EACCES'
}

type AttemptResult =
  | { ok: true; lastSyncAt: string | null }
  // `reason` is set only when the retry is a quick_check failure — if this
  // turns out to be the last attempt, readCacheInfo reports that specific
  // message instead of the generic "being written" one, since a real,
  // reproducible integrity problem (as opposed to a torn snapshot that a
  // fresh copy might fix) is a more useful thing to say.
  | { ok: false; retry: true; reason?: string }
  | { ok: false; retry: false; error: string }

// One attempt at the snapshot-and-read described on `readCacheInfo`. Always
// cleans up its own temp directory, even on failure — cleanup itself is
// best-effort (see the `finally` below) and never changes the outcome.
function attemptSnapshot(path: string): AttemptResult {
  let tempDir: string | null = null
  try {
    // Confirm the real cache file (and its `-wal`, if it has one) is
    // actually readable before touching anything else. This has to happen
    // up front, rather than just reacting to whatever `copyFileSync` throws
    // later: its thrown error can't be trusted to say which side failed
    // (see `isLikelyTempSideError`), so the only reliable way to tell "the
    // cache itself is unreadable" apart from "our own temp copy failed" is
    // to rule the former out explicitly, first. A failure here is reported
    // as-is — the same shape as any other cache-side error — with no retry
    // (a permission problem doesn't resolve itself within a few attempts)
    // and no "could not snapshot the cache" prefix (that's reserved for
    // problems on the temp side, not the real cache).
    try {
      accessSync(path, fsConstants.R_OK)
    } catch (e) {
      return { ok: false, retry: false, error: (e as Error).message }
    }
    try {
      accessSync(walPath(path), fsConstants.R_OK)
    } catch (e) {
      // `ENOENT` just means there's no `-wal` right now (the common case for
      // a cleanly-closed cache) — nothing to check yet at this point, since
      // no `before` snapshot exists yet for its absence to be a *change*
      // from. Anything else (most plausibly `EACCES`) is a real cache-side
      // access problem on a `-wal` that does exist.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, retry: false, error: (e as Error).message }
      }
    }

    try {
      tempDir = mkdtempSync(join(tmpdir(), 'zm-status-'))
    } catch (e) {
      const message = (e as Error).message
      // mkdtemp only ever touches the temp side — the source was already
      // confirmed readable just above — so unlike a copy failure, no
      // separate disambiguation is needed here.
      return { ok: false, retry: false, error: `could not snapshot the cache: ${message}` }
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
      // The `-wal` existed an instant ago (per `before`, taken after the
      // access checks above) but is gone now — most likely a writer just
      // checkpointed and removed it. That's a real change to the cache
      // mid-snapshot, not a hard failure: retry with a fresh copy rather
      // than reporting unreadable.
      if (err.code === 'ENOENT' && err.path === walPath(path)) {
        return { ok: false, retry: true }
      }
      // The source was already confirmed readable above, so a failure
      // reaching here is far more likely to be a genuine temp-side problem
      // (e.g. the temp filesystem filling up between then and now).
      if (isLikelyTempSideError(err)) {
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
        // Reached only after the before/after stability check above already
        // passed, so this is most likely a tear that check's coarse
        // size/mtime/wal-header comparison missed (e.g. a filesystem with
        // low mtime resolution) rather than a reproducible integrity
        // problem — worth another attempt with a fresh copy, same as an
        // outright stability mismatch, rather than giving up immediately.
        // `reason` carries the message forward in case this turns out to be
        // the last attempt.
        return { ok: false, retry: true, reason: `cache integrity check failed: ${checkResult}` }
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
// on the resulting copy catches whatever that comparison might still miss
// (e.g. a filesystem whose mtime resolution is too coarse to register a
// change that landed within the same tick). Either one failing (or the
// `-wal` disappearing mid-copy, or a permission problem on `-wal`
// specifically that appeared after it was already confirmed present — see
// `attemptSnapshot`) means a retry with a fresh temp dir, up to
// `MAX_SNAPSHOT_ATTEMPTS` times. Once every attempt has been exhausted,
// this reports the *last* attempt's specific reason if it was a
// quick_check failure (a real, reproducible integrity problem is more
// useful to say than "try again"), or otherwise the generic "being
// written" message, since at that point a writer is genuinely,
// persistently active rather than status having hit one unlucky moment.
//
// A permission problem on the real cache file (or its `-wal`) is a
// different kind of failure entirely — not transient, and not something a
// retry could ever fix — and is reported immediately via `attemptSnapshot`'s
// own `accessSync` checks, with `retry: false`, before any of the above
// ever runs.
function readCacheInfo(path: string, now: () => Date): CacheInfo {
  if (!existsSync(path)) {
    return { path, exists: false, readable: false, lastSyncAt: null, ageHours: null }
  }

  let lastRetryReason: string | null = null
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
    lastRetryReason = result.reason ?? null
  }
  const error = lastRetryReason ?? 'cache is being written by another process, retry shortly'
  return { path, exists: true, readable: false, lastSyncAt: null, ageHours: null, error }
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
        ownersFile: readOwnersFileInfo(ctx.paths.configDir),
        version: readVersion(),
      }
      printResult({ data, meta: {} }, format, ctx.stdout)
    })
}
