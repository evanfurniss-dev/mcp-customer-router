# Customer MCP Router

A local connection manager for Glide customers. Each customer has a separate saved authorization. Claude Code and Codex share it through their project settings. T3 Code can use those settings through its provider adapters.

This MVP is built for local use on [mcp-remote](https://github.com/punkpeye/mcp-remote), based on upstream commit `71cadf3aaa935608d5e14d472a59e9583ebb9505`. The upstream bridge and license remain in this fork. Its original instructions are in [UPSTREAM-README.md](docs/UPSTREAM-README.md).

## Install on a Mac

With [Homebrew](https://brew.sh) installed:

```sh
brew install evanfurniss-dev/tap/mcp-customer-router
mcp-customer-router service install --open
```

Homebrew installs Node and the built application. Each person connects their own Glide organizations. The download contains no customer records or credentials. The dashboard runs locally and starts at login. It uses port 4773 by default.

To update:

```sh
brew update
brew upgrade evanfurniss-dev/tap/mcp-customer-router
mcp-customer-router service restart
```

Start fresh Claude Code and Codex sessions to load the updated bridge. Homebrew installations save stable paths, so upgrades keep new project connections usable. Stop any active sign-in or check before restarting.

To remove the application while keeping saved customer data:

```sh
mcp-customer-router service uninstall
brew uninstall mcp-customer-router
```

The package targets macOS. The service runs while the user is logged in and the Mac is awake. Homebrew's `brew services` command is not used; the router manages its own user service.

## Run from source

Requires Node.js 22.12 or newer and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm --dir web install --frozen-lockfile
pnpm build
node dist/router-cli.js service install --open
```

On macOS, this installs a user LaunchAgent and the command `~/.local/bin/mcp-customer-router`. The dashboard starts at login, stays available at `http://127.0.0.1:4773`, and restarts after an exit. You can close Terminal and the browser. Opening **Start Customer MCP Router.command** installs or starts the same service and opens the dashboard.

```sh
mcp-customer-router open
mcp-customer-router service status
mcp-customer-router service restart
```

If `~/.local/bin` is not on your shell's PATH, use `~/.local/bin/mcp-customer-router open`. The service uses an absolute Node path and does not depend on your shell's PATH. Installation refuses an occupied port and leaves the existing process alone. Stop an older foreground dashboard before installing.

`service stop` stops the dashboard and disables startup at login until `service start`. `service uninstall` removes the LaunchAgent and CLI shortcut while preserving customer data. Logs are in `~/.mcp-customer-router/logs/`. Restarting the service stops active dashboard checks and sign-in jobs; it does not restart independent MCP bridges already owned by Claude or Codex.

The service runs while your macOS user is logged in. Work pauses during sleep; it is not an always-on cloud host. For a foreground process, development, or another operating system, use `node dist/router-cli.js dashboard --open`.

## Connect a customer

1. Select **Add customer**. Enter its name and business label. Copy its organization ID from its Glide URL, such as the ID after `/o/` in `https://os.glideapps.dev/o/ORG_ID/projects`.
2. Open the customer and select **Connect Glide**. If a browser does not open, select **Open Glide sign-in** in the active job. Finish Glide sign-in and choose that organization. The router reads `project_list` and checks its server-owned organization citation before showing **Verified**.
3. Select **Choose folder** to pick the customer's local project in the macOS folder dialog, or enter its full path. Select **Preview config** to preview the generated Claude and Codex settings. Review any warnings about existing Glide connections, then select **Apply config**.
4. Open a fresh Claude Code or Codex session in that project. Codex requires the project to be trusted. Claude may ask to approve the project's MCP entry. These are local project approvals; they do not repeat Glide sign-in. In T3, open that project and start a fresh provider session.

**Connect Glide** and **Reconnect Glide** start a fresh authorization for only the selected customer. It invalidates older router sessions for that customer. **Check identity** reuses the saved grant and never opens a new sign-in. Refresh of an existing grant happens automatically.

Homebrew project settings use stable installation paths. Source installations use absolute paths to the checkout and Node. If you move a source checkout or change installation methods, review and update those entries. Existing differing `customer-glide` entries are refused to prevent silent rebinding. A separate Git worktree needs its own binding; a copied entry still points at the original checkout and must be reviewed before reuse.

## What it owns

- A customer registry, organization expectations, and project bindings in `~/.mcp-customer-router/`.
- Separate private credential directories and stable OAuth callback ports for each customer.
- A `customer-glide` entry in `.mcp.json` and `.codex/config.toml` for each project you explicitly bind. Other settings are preserved. Existing files receive private backups.
- One bridge process per active client. Claude and Codex read the same customer's saved credential store while keeping independent protocol connections.

Configuration previews contain only the generated snippets. An active sign-in link stays in job memory until the job ends. Existing configuration content and OAuth credentials stay out of API responses. The local dashboard checks its host, browser origin, and session token. It binds only to `127.0.0.1`.

The MVP supports `https://mcp.glideapps.dev/mcp`. Loopback HTTP servers exist for automated tests. It blocks tools if organization identity is absent or differs from the saved expectation. It also stops older sessions when a new customer sign-in begins. A timeout or cancellation does not prove that a remote write was rolled back; check the result before retrying it.

## Limits

This provides saved-connection separation under one operating-system account. An agent with broad file access under that account can reach other credential directories. Strong isolation between untrusted tenants needs a separate execution boundary.

Existing global or project Glide connections can still be available to agents. The router reports detected entries for review and does not disable them automatically. T3's own provider override settings and organization policies can also affect effective configuration. Verify the active MCP list in each client.

The dashboard service must be running to manage customers in the browser. Each client starts its own customer bridge, which can run with the dashboard stopped. Work runs on the Mac and stops when its execution process is unavailable. This release has no hosted execution or scheduler. Credentials use private files, not Mac Keychain. Removing a customer entry retains its protected credential files for recovery and does not revoke the grant at Glide; removal is blocked while projects remain bound.

## Commands

```sh
node dist/router-cli.js --help
mcp-customer-router --version
mcp-customer-router list
mcp-customer-router add --name "Customer" --business "Business" --org ORG_ID
mcp-customer-router connect --customer CUSTOMER_UUID
mcp-customer-router check --customer CUSTOMER_UUID
node dist/router-cli.js dashboard --port 4774
```

Use `--home /absolute/path` for an isolated registry. A user can install one dashboard service; service commands must use its installed `--home` and `--port`. Keep data directories outside Git. The `serve` command is generated into client configuration and requires a matching saved project binding and project working directory.

## Verification

```sh
pnpm lint
pnpm knip
pnpm test
pnpm build
```

The router tests use temporary directories and a local OAuth/MCP fixture. They exercise shared refresh, concurrent clients, separate organizations at the same URL, organization mismatch, revoked access, generation changes, project config preservation, preview conflicts, rollback, and browser request protections. They do not authorize real Glide accounts or execute customer writes.

Live Glide sign-in and provider behavior after that sign-in remain an acceptance step. Use two test organizations, connect each once, and open both Claude and Codex against each. Confirm the organization before allowing writes. See [VERIFICATION.md](docs/VERIFICATION.md) for results and the remaining boundary.

[UI source and license record](docs/UI-SOURCES.md) · [Codex MCP configuration](https://developers.openai.com/codex/mcp) · [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)

Maintainers: [packaging and release instructions](docs/RELEASING.md).
