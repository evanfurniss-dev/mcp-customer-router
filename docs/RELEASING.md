# Homebrew releases

The tap is `evanfurniss-dev/homebrew-tap`. Its `Formula/mcp-customer-router.rb` downloads a prebuilt archive from this repository's GitHub Releases. Homebrew supplies Node. No npm publication, hosted service, or cross-repository token is required.

## Build and check

Use a clean checkout and the Node/pnpm versions in CI. Change the root package version for each release. Router tags use `router-vVERSION` to avoid upstream mcp-remote tags.

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

The packager stages an explicit file list in a temporary directory. It installs locked production dependencies with lifecycle scripts disabled and includes the dashboard, copied UI licenses, and notices for bundled dependencies. It rejects symlinks that leave the staged application. Files under the user's home and project settings are never collected.

`release/` contains the archive, its SHA-256 checksum, and a formula with the matching checksum. Do not rebuild or replace an archive after publishing it. A changed archive needs a new version.

The smoke check extracts the actual archive into a temporary installation. It checks CLI startup, a fresh registry, dashboard assets, the connection child, generated client paths, a switch of the stable install link, removal of the old version, and restart with saved state. It uses no live credentials and does not install a LaunchAgent.

## Publish

Update `docs/RELEASE-NOTES.md`, commit, and push the version tag. Run **Package release** in GitHub Actions with that existing tag. The workflow builds, checks, and publishes the archive and generated formula. It refuses a tag that differs from the package version and refuses to overwrite an existing release.

Alternatively, after local checks, create the release with `gh release create`, pass `--verify-tag`, attach only the current version's archive, checksum, and generated formula, and use `--notes-file docs/RELEASE-NOTES.md`. Older archives may remain in `release/`; do not use a wildcard when publishing.

Copy the generated `mcp-customer-router.rb` into `Formula/` in the tap repository, review its URL and checksum, then commit and push that file. Use a fresh installation to run:

```sh
brew install evanfurniss-dev/tap/mcp-customer-router
brew test evanfurniss-dev/tap/mcp-customer-router
```

The formula writes `dist/install-paths.json` with Homebrew's stable `opt` paths for Node and the CLI. The router uses these paths for project configurations, background startup, child processes, and web assets. Installation does not start the service or modify client projects. Users run `service install --open` explicitly.

Updates require `service restart` and fresh client sessions. Uninstall the user service before `brew uninstall`; customer data remains in `~/.mcp-customer-router`.

## Acceptance boundary

Automated package checks do not prove a new user's Glide access. Before wider distribution, use another macOS account with two test Glide organizations and verify sign-in, project binding, and tool identity in both Claude Code and Codex. The live service installation and native folder chooser also need a check in that account. Intel Mac operation remains unverified until tested on that hardware.

Source-checkout users retain their existing service and project entries until they choose to migrate. Do not silently rewrite a differing `customer-glide` configuration.
