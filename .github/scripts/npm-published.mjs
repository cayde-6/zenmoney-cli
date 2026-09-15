// Exit 0 if <name>@<version> is already published on the npm registry, 1 if
// not. Used by release.yml to decide whether `npm publish` should run at
// all — the first release of any given version is published manually once
// (see docs/versioning.md's one-time setup), and `npm publish` fails
// outright if the version already exists, so release.yml must check first
// rather than assume. `isPublished` takes an injectable command runner
// (defaulting to the real execFileSync) so it's unit-testable without ever
// making a real network call — see tests/scripts/npm-published.test.ts.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

export function isPublished(name, version, run = execFileSync) {
  try {
    const out = run('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' })
    return out.trim() === version
  } catch {
    // `npm view` exits non-zero (E404) when the name or version doesn't
    // exist — that's the normal "not published yet" case, not a real error.
    return false
  }
}

// Exit codes are load-bearing: release.yml's "Check whether this version is
// already published" step maps 0 -> already published (skip `npm publish`),
// 1 -> not published (run `npm publish`), and anything else -> fail the job
// closed rather than guess. main() below must always reach exactly one of
// these via process.exit — never fall through to node's implicit exit(0).
export const EXIT_PUBLISHED = 0
export const EXIT_NOT_PUBLISHED = 1
export const EXIT_USAGE_ERROR = 2
export const EXIT_UNEXPECTED_ERROR = 3

// Computes the exit code without touching process.exit, so the code mapping
// itself is unit-testable in-process (see tests/scripts/npm-published.test.ts)
// — main() is the only thing that actually exits the process.
// `checkPublished` defaults to isPublished (with its own default `run`) but
// is overridable in tests to force the EXIT_UNEXPECTED_ERROR branch, which
// isPublished itself never triggers (it catches everything internally).
export function exitCodeFor(name, version, checkPublished = isPublished) {
  if (!name || !version) return EXIT_USAGE_ERROR
  try {
    return checkPublished(name, version) ? EXIT_PUBLISHED : EXIT_NOT_PUBLISHED
  } catch {
    return EXIT_UNEXPECTED_ERROR
  }
}

function main() {
  const [, , name, version] = process.argv
  if (!name || !version) {
    console.error('usage: npm-published.mjs <name> <version>')
  }
  process.exit(exitCodeFor(name, version))
}

// Only run as a CLI when invoked directly (`node npm-published.mjs ...`),
// not when imported by the unit test. Compares realpathSync of both sides
// rather than the raw path strings: invoked through a symlink (e.g. a
// wrapper script, or a differently-cased path on a case-insensitive
// filesystem), `process.argv[1]` and `import.meta.url` can point at the
// same file without being string-equal, which used to make this guard
// silently skip main() — the process then exited 0 by default (node's
// implicit exit code with no explicit process.exit call), and release.yml's
// `if node .github/scripts/npm-published.mjs ...; then` reads exit 0 as
// "already published", wrongly skipping `npm publish` on every release
// (fail-open). realpathSync resolves symlinks on both sides before
// comparing, so this now runs main() correctly regardless of how the
// script was invoked.
let isMain = false
if (process.argv[1]) {
  try {
    isMain = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    // argv[1] doesn't resolve to a real file (e.g. an unusual invocation) —
    // treat that as "not being run as the CLI" rather than crash before
    // main() gets a chance to run.
    isMain = false
  }
}
if (isMain) {
  main()
}
