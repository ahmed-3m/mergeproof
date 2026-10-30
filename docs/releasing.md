# Releasing

A release is a semver tag on `main`. [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on the tag push: it runs `npm test`, publishes `@ahmed-3m/mergeproof` to npm, moves the `v1` action tag to the release, and creates the GitHub Release from the tag's CHANGELOG section.

## Before the first npm publish

- **Repository visibility.** The repository is public, so npm provenance works, the README links resolve for everyone, and other repositories can use `ahmed-3m/mergeproof@v1`. If it is ever made private again, provenance fails (the workflow falls back to a plain publish) and other repositories lose the action.
- **`NPM_TOKEN` secret.** Create a granular access token on npmjs.com with read and write access to the `@ahmed-3m` scope, then store it with `gh secret set NPM_TOKEN`. Without it the workflow logs `NPM_TOKEN is not set; skipping npm publish` and still moves `v1` and creates the Release. That is what happened for v0.1.0 to v0.1.2.

## Cutting a release

1. On a branch, bump the version in `package.json` and `src/version.mjs` (`tests/structure.test.mjs` checks they match), and rename `## [Unreleased]` in `CHANGELOG.md` to `## [x.y.z] - YYYY-MM-DD` above a new, empty `## [Unreleased]`.
2. Merge that PR once CI passes (the `package-smoke` job installs the packed tarball and runs the bin).
3. Tag the merge commit and push the tag. That push publishes:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z" origin/main
   git push origin vX.Y.Z
   ```

4. Check that `npm view @ahmed-3m/mergeproof version` shows the new version, and that the `v1` tag points at it.

Re-running the release workflow for the same tag is safe: a version that is already published is tolerated, and the Release is created only when it is missing.
