# Versioning

`@cayde-6/zenmoney-cli` follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):
`MAJOR.MINOR.PATCH`.

Given the `CHANGELOG.md` entry being released, bump:

- **MAJOR** for a breaking change: a command, flag, or output shape removed
  or changed incompatibly (an entry that would itself be described as
  "Changed" or "Removed" in a way existing scripts/agents could not survive
  unmodified — e.g. renaming a JSON field, changing an exit code's meaning,
  removing a command or flag).
- **MINOR** for a backward-compatible addition — a new command, flag, or
  additive field ("Added" entries that don't change any existing behavior).
- **PATCH** for a backward-compatible bug fix ("Fixed" entries), or any
  internal/tooling change with no user-visible CLI behavior change at all
  (build, CI, docs, test coverage).

There is no pre-1.0 "anything goes" exception here: `0.x` releases still
follow the rules above, just with `MAJOR` staying at `0` until the CLI's
interface is considered stable.

## Release process

Publishing is a **manual version bump + manual git tag push** — no
changesets, semantic-release, or release-please. See
[`release-checklist.md`](release-checklist.md) for the exact steps.

In short: bump `version` in `package.json` by hand, add a dated section to
`CHANGELOG.md` by hand, run `npm run verify`, tag `vX.Y.Z`, push the tag —
`.github/workflows/release.yml` then builds, verifies again, publishes to
npm with provenance, and creates a GitHub release with the exact published
tarball attached.

## One-time publishing setup

Before the very first tag push, a maintainer needs to do the following
once (none of this is expressed in repo files). `release.yml` itself
checks whether the tagged version is already published and skips
`npm publish` if so (see `.github/scripts/npm-published.mjs`) — that's
exactly what makes step 4 below safe.

Steps 1 and 2 below must both be run from a **clean checkout of the exact
`main` commit that `v0.1.0` will point to** once it's merged and tagged
(`git status` clean, `git log -1` showing that commit) — not a working
tree with local, uncommitted, or out-of-date changes. This is what makes
the manually-published npm tarball and the tag's later GitHub release
tarball come from the same source tree: the GitHub release tarball is not
this manual one — it's rebuilt independently in CI, from that same tag,
when the tag is pushed (see step 4 and `release-checklist.md`). If the two
were built from different trees, `npm install @cayde-6/zenmoney-cli` and
downloading the GitHub release tarball could silently hand out different
code for the same version number.

1. **Verify**, from that clean checkout:

   ```
   npm run verify
   ```

2. **First manual publish**, from that same clean checkout, logged in to
   an npm account with publish rights:

   ```
   npm publish --access public --provenance=false
   ```

   `--provenance=false` is required here: provenance attestation only
   works when npm can prove the publish came from a supported CI
   environment (it inspects `CI`/OIDC environment variables) — it always
   fails from a local machine. This first publish creates the
   `@cayde-6/zenmoney-cli` package on the npm registry; npm's Trusted
   Publisher configuration (next step) can only be attached to a package
   that already exists.

3. **Configure npm Trusted Publishing.** On the package's settings page on
   npmjs.com, add a Trusted Publisher with:
   - Publisher: GitHub Actions
   - Organization or user: `cayde-6`
   - Repository: `zenmoney-cli`
   - Workflow filename: `release.yml`
   - Environment: (leave empty — `release.yml` doesn't use a GitHub
     Environment)

   Then, on the same package settings page, turn on **"Require two-factor
   authentication and disallow tokens"** — with Trusted Publishing
   configured, `release.yml` no longer needs a classic token to publish, so
   this can be enforced without breaking CI.

4. **Push the `v0.1.0` tag**, pointing at the exact commit steps 1–2 were
   run from. `release.yml` checks out that commit, builds its own tarball
   independently (this is the GitHub release tarball, not the one manually
   published in step 2), sees `0.1.0` is already published on npm (from
   step 2), logs a notice, skips `npm publish`, and creates the GitHub
   release from the tarball it just built.

5. **Add the `CODECOV_TOKEN` repository secret**, so `ci.yml` can upload
   coverage to Codecov (`fail_ci_if_error: false`, so CI still passes
   without it — but coverage reporting won't work until it's set).

6. **Use a publishing account without personal information in its npm
   metadata.** An npm account's profile name and email are public; the
   account used in steps 2–3 (and that owns/administers the package
   afterwards) should not have a real name or personal email set, per this
   repository's own privacy stance (see `SECURITY.md`).

After this one-time setup, every later release is just: bump `version` in
`package.json`, add a `CHANGELOG.md` entry, tag, push tag — CI verifies,
publishes to npm with full provenance (this time from `release.yml`
itself, which does satisfy npm's provenance requirements), and creates the
GitHub release.
