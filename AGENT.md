# MCP Customer Router contributor guide

## Scope

This repository adds customer-bound Glide MCP connections and a local dashboard to the upstream `mcp-remote` OAuth bridge. Keep router changes separate from unrelated upstream behavior. Preserve the MIT license and upstream attribution.

## Commands

- Install: `pnpm install --frozen-lockfile` and `pnpm --dir web install --frozen-lockfile`.
- Build the bridge and dashboard: `pnpm build`.
- Lint and check backend types: `pnpm lint`. The frontend type check runs in `pnpm --dir web build`.
- Check unused code: `pnpm knip`.
- Run the offline test suite: `pnpm test`. Use `pnpm check:router` for a focused router check.
- Format: `pnpm format`. The formatter excludes `web/`, `README.md`, and the archived upstream README.
- Package and check a release: `pnpm release:package`, then `pnpm release:smoke`. Follow `docs/RELEASING.md` before publishing.
- Run a disposable dashboard: `node dist/router-cli.js dashboard --home /absolute/path/to/temporary-router-data --port 4774` after building.

The pre-commit hook runs lint, Knip, and the offline tests. CI also builds the bridge and frontend on the supported Node versions.

The tests under `test/` are inherited integration checks and can contact live third-party MCP services. Do not run them by default. Obtain authorization for live accounts and external actions before using them. The manual upstream compatibility workflow is separate from normal router CI.

## Architecture

- `src/router-cli.ts`: CLI entry point and dashboard/service commands.
- `src/router/`: customer registry, process isolation, organization checks, local API, project settings, and macOS service management.
- `src/router-connection.ts`: dedicated process for one customer connection.
- `src/lib/`, `src/client.ts`, and `src/proxy.ts`: inherited `mcp-remote` OAuth and transport code.
- `web/`: React dashboard with its own pinned dependencies and lockfile.
- `scripts/` and `packaging/`: portable release archive, smoke check, and Homebrew formula template.

The router stores customer records, project bindings, and separate customer credentials under `~/.mcp-customer-router/` by default. Each connection process receives its own credential directory. The inherited bridge has a separate storage layout under `~/.mcp-auth/`; preserve its versioning and compatibility rules.

## Change and test boundaries

- Use temporary data homes and synthetic organizations for tests. Never use a real customer's saved credentials, change client settings, install or restart a user service, or start browser authorization as part of an ordinary test run.
- Keep dashboard previews read-only. Apply only the reviewed settings and explicit Remove choices, with backups and conflict checks.
- Preserve organization checks before tool access, separate customer credential stores, and errors that block access when identity is uncertain.
- Keep existing client configuration contents, tokens, authorization codes, and customer records out of logs, screenshots, fixtures, release archives, and Git.
- Verify UI changes in the real interface with synthetic data. Check keyboard operation, dark mode, and narrow layouts when affected.
- Report live-client, OAuth, and platform behavior separately from fixture results. A passing local test does not establish compatibility with every agent.

## Code style

Use the existing TypeScript ESM conventions and local UI primitives. Root formatting uses 140 columns, single quotes, and no semicolons. Keep changes focused; add tests for observable behavior and failure cases. Update the user documentation when commands, storage, setup, or supported clients change.
