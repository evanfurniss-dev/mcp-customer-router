# Contributing

Keep changes focused on local customer connections, safe configuration edits, and clear setup. Open an issue before starting a large feature or adding another connector.

## Run from source

Use Node.js 22.12 or newer and the pnpm version declared in `package.json`. CI checks Node 22 and 24.

```sh
git clone https://github.com/evanfurniss-dev/mcp-customer-router.git
cd mcp-customer-router
pnpm install --frozen-lockfile
pnpm --dir web install --frozen-lockfile
pnpm build
router_dev_home="$(mktemp -d)"
node dist/router-cli.js dashboard --home "$router_dev_home" --port 4774 --open
```

Use a dedicated `--home` and an unused port during development. Keep that data directory outside the repository. Use test organizations if a change requires a live sign-in. The dashboard command runs in the foreground and does not install a service.

## Check a change

```sh
pnpm lint
pnpm knip
pnpm test
pnpm build
```

Run `pnpm format` to format files. Review its diff before committing. Frontend types are checked during the build. For release packaging, also run `pnpm release:package` and `pnpm release:smoke` as described in [the release guide](docs/RELEASING.md).

Tests use temporary files and local MCP/OAuth fixtures. Add tests for changed behavior, especially customer identity, configuration preservation, concurrent use, and recovery after failure. Check visible UI changes in a browser, including keyboard use and narrow layouts. State which client paths you tested and which remain unverified.

Live upstream compatibility checks are a separate manual workflow. They contact third-party servers and are not required for ordinary local changes.

## Submit a pull request

Explain the problem, the resulting behavior, and the checks performed. Include a screenshot for visible changes and update user documentation when setup changes. Preserve upstream copyright and license notices.

Never commit customer data, credentials, authorization URLs, settings backups, or complete local configuration files. Use synthetic examples in tests and screenshots. Report security issues through the [security policy](SECURITY.md).
