# Release checklist

Before the very first release, complete the one-time setup in
[`versioning.md`](versioning.md#one-time-publishing-setup) (npm Trusted
Publisher, `CODECOV_TOKEN`, publishing account) — critically, the manual
`npm publish` there must be run from a clean checkout of the exact `main`
commit that `v0.1.0` will be tagged at (after this branch merges), so that
tarball and the GitHub release tarball CI later rebuilds from the `v0.1.0`
tag come from the same tree. Every release after that just follows the
steps below.

1. On `main`, with a clean working tree:

   ```
   npm ci
   npm run verify
   ```

   `verify` runs `check` (typecheck), `build`, and `test:coverage`
   (vitest with the enforced coverage thresholds) — it must pass locally
   before tagging.

2. Bump `version` in `package.json` by hand, following
   [`versioning.md`](versioning.md)'s semver rules.

3. Move `CHANGELOG.md`'s `[Unreleased]` section to a new dated
   `## [X.Y.Z] - YYYY-MM-DD` section (leave a fresh empty `[Unreleased]`
   above it), and add the new version's compare link at the bottom:

   ```
   [Unreleased]: https://github.com/cayde-6/zenmoney-cli/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/cayde-6/zenmoney-cli/compare/v<previous>...vX.Y.Z
   ```

4. Commit the version bump and changelog update:

   ```
   git commit -am "chore: release vX.Y.Z"
   ```

5. Tag and push:

   ```
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

6. Pushing the tag triggers `.github/workflows/release.yml`, which:
   - fails fast if the tag (without its `v`) doesn't match `package.json`'s
     `version` — before installing anything
   - checks out, runs `npm ci && npm run verify`
   - packs the exact tarball that will be published (`npm pack`) into
     `release/`
   - checks whether this exact version is already on npm
     (`.github/scripts/npm-published.mjs`); if so (this is expected for the
     very first release, `v0.1.0` — see
     [`versioning.md`](versioning.md#one-time-publishing-setup)), logs a
     notice and skips publishing instead of failing
   - otherwise publishes it to npm (`npm publish --access public
     --provenance`, via Trusted Publishing — no token involved)
   - either way, creates a GitHub release (`gh release create
     --generate-notes --verify-tag`) with that same tarball attached

7. Confirm the release: check the
   [Release workflow run](https://github.com/cayde-6/zenmoney-cli/actions/workflows/release.yml),
   the [npm package page](https://www.npmjs.com/package/@cayde-6/zenmoney-cli),
   and the [GitHub releases page](https://github.com/cayde-6/zenmoney-cli/releases).

If step 6 fails after the tag is already pushed, fix the issue and push a
new patch tag rather than force-pushing or deleting the failed one — a tag
that reached `npm publish` can never be safely reused (npm permanently
blocks republishing a version, even after unpublishing it).
