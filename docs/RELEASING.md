# Homebrew releases

The tap is [evanfurniss-dev/homebrew-tap](https://github.com/evanfurniss-dev/homebrew-tap). Its `Formula/mcp-customer-router.rb` downloads a prebuilt archive from this repository's GitHub Releases. Homebrew supplies Node. Publication uses GitHub's repository token; it needs no npm account or cross-repository token.

## Build and check

Use a clean checkout and the Node/pnpm versions in CI. Update the root package version, `CHANGELOG.md`, and `docs/RELEASE-NOTES.md` together. Router tags use `router-vVERSION` to avoid upstream mcp-remote tags.

```sh
pnpm install --frozen-lockfile
pnpm --dir web install --frozen-lockfile
pnpm lint
pnpm knip
pnpm test
pnpm build
pnpm release:package
pnpm release:smoke
```

The packager stages an explicit file list in a temporary directory. It installs locked production dependencies with lifecycle scripts disabled and includes the dashboard, documentation, screenshots, copied UI licenses, and notices for bundled dependencies. It rejects symlinks that leave the staged application. Files under the user's home and project settings are never collected.

`release/` contains the archive, its SHA-256 checksum, and a formula with the matching checksum. Do not rebuild or replace an archive after publishing it. A changed archive needs a new version.

The smoke check extracts the actual archive into a temporary installation. It checks:

- CLI startup, a fresh registry, shipped documents, and dashboard assets containing the new setup UI.
- Preview, Remove, and Ignore through the packaged HTTP API, with synthetic settings. It verifies that preview hides a sample secret, choices are required, unverified customers cannot apply, and removals preserve other settings and create private backups.
- The connection child, generated client paths, a switch of the stable install link, removal of the old version, and restart with saved state.

The smoke check seeds a verified record only in its temporary registry to exercise configuration changes. This is not a live identity test. It uses no live credentials and does not install a LaunchAgent.

## Publish

Commit and push the release changes to `main`. Wait for **Router checks** to pass for that commit. From that commit, set the tag and start **Package release**:

```sh
version=$(node -p 'require("./package.json").version')
tag="router-v${version}"
git tag "$tag"
git push origin "$tag"
gh workflow run release.yaml --ref main -f "tag=$tag"
```

The workflow checks out the existing tag, checks that the tag, commit, and package version agree, then runs lint, dependency checks, tests, build, packaging, smoke checks, and checksum verification before publishing. It refuses to overwrite an existing release. Each action is pinned to a commit. The live upstream compatibility workflow is manual and uses its own locked test dependencies; it does not publish.

Download the formula from the completed release so the tap uses the checksum of the **published** archive:

```sh
mkdir -p release/published
gh release download "$tag" \
  --pattern mcp-customer-router.rb \
  --pattern "mcp-customer-router-${version}.tar.gz" \
  --pattern "mcp-customer-router-${version}.tar.gz.sha256" \
  --dir release/published
(cd release/published && shasum -a 256 -c "mcp-customer-router-${version}.tar.gz.sha256")
pnpm release:smoke "release/published/mcp-customer-router-${version}.tar.gz"
```

Copy `release/published/mcp-customer-router.rb` into `Formula/` in the tap checkout. Review its URL and checksum, then commit and push that file. Do not copy a locally rebuilt formula over the one from the published release: separate builds can have different archive checksums.

A local publication path is also supported after the same checks. Attach only the current archive, checksum, and generated formula:

```sh
gh release create "$tag" \
  "release/mcp-customer-router-${version}.tar.gz" \
  "release/mcp-customer-router-${version}.tar.gz.sha256" \
  release/mcp-customer-router.rb \
  --verify-tag --title "Customer MCP Router ${version}" \
  --notes-file docs/RELEASE-NOTES.md
```

Use one publication path per version. Older archives may remain in `release/`; do not use a wildcard when publishing.

## Check installation and upgrade

Use a fresh installation to check:

```sh
brew install evanfurniss-dev/tap/mcp-customer-router
brew test evanfurniss-dev/tap/mcp-customer-router
mcp-customer-router --version
```

For an existing installation:

```sh
brew update
brew upgrade evanfurniss-dev/tap/mcp-customer-router
brew test evanfurniss-dev/tap/mcp-customer-router
mcp-customer-router service restart
mcp-customer-router open
```

The formula writes `dist/install-paths.json` with Homebrew's stable `opt` paths for Node and the CLI. The router uses these paths for project configurations, background startup, child processes, and web assets. Installation does not start the service or modify client projects. Users run `service install --open` explicitly.

Updates require `service restart` and fresh client sessions. Uninstall the user service before `brew uninstall`; customer data remains in `~/.mcp-customer-router`.

## Acceptance boundary

Automated package checks do not prove a new user's Glide access. Before wider distribution, use another macOS account with two test Glide organizations and verify sign-in, project binding, and tool identity in both Claude Code and Codex. The live service installation and native folder chooser also need a check in that account. Intel Mac operation remains unverified until tested on that hardware. Client-specific evidence and limits are in [CLIENT-SETUP.md](CLIENT-SETUP.md).

Source-checkout users retain their existing service and project entries until they choose to migrate. Do not silently rewrite a differing `customer-glide` configuration.
