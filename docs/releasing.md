# Releasing

A release is a semver tag on `main`. [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on the tag push: it runs `npm test`, publishes `@ahmed-3m/mergeproof` to npm, moves the `v1` action tag to the release, and creates the GitHub Release from the tag's CHANGELOG section.

## Before the first npm publish

- **Repository visibility.** The repository is public, so npm provenance works, the README links resolve for everyone, and other repositories can use `ahmed-3m/mergeproof@v1`. If it is ever made private again, provenance fails (the workflow falls back to a plain publish) and other repositories lose the action.
- **`NPM_TOKEN` secret.** Create a granular access token on npmjs.com with **Read and write (publish and stage)** access to the `@ahmed-3m` scope and **Bypass two-factor authentication (2FA)** checked, then store it with `gh secret set NPM_TOKEN`. Without it the workflow logs `NPM_TOKEN is not set; skipping npm publish` and still moves `v1` and creates the Release. That is what happened for v0.1.0 to v0.1.2.

## Cutting a release

1. On a branch, bump the version in `package.json` and `src/version.mjs` (`tests/structure.test.mjs` checks they match), and rename `## [Unreleased]` in `CHANGELOG.md` to `## [x.y.z] - YYYY-MM-DD` above a new, empty `## [Unreleased]`.
2. Merge that PR once CI passes (the `package-smoke` job installs the packed tarball and runs the bin).
3. Tag the merge commit and push the tag. That push publishes:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z" origin/main
   git push origin vX.Y.Z
   ```

4. Check that `npm view @ahmed-3m/mergeproof version` shows the new version, and that the `v1` tag points at it.
5. **Publish the release to the GitHub Marketplace** (first publish, and every release the listing should move to). The workflow does not do this and the REST API cannot: in the web UI, open the release, click **Edit** (pencil), check **Publish this Action to the GitHub Marketplace**, confirm the metadata reads "Everything looks good", pick a primary category (mergeproof uses *Security*), and **Update release**. The listing name is the `name:` in `action.yml` (`mergeproof-gate`) and must be unique on the Marketplace — `mergeproof` is taken by an unrelated project. A release published without the checkbox leaves the listing pointing at the previous version.

Re-running the release workflow for the same tag is safe: a version that is already published is tolerated, and the Release is created only when it is missing.

If the workflow warns `could not move v1 with GITHUB_TOKEN` — any release after a promote, whose tree changes `.github/workflows/` — move the tag by hand (no GITHUB_TOKEN scope can do it; a PAT with the `workflow` scope could):

```bash
git fetch origin
git tag -fa v1 -m "v1 tracks the latest release" <the-release-commit>
git push origin v1 --force
```
