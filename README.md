# Customer MCP Router

A local connection manager for Glide customers. Each customer has a separate saved authorization. Claude Code and Codex share it through their project settings. T3 Code can use those settings through its provider adapters.

This MVP is built for local use on [mcp-remote](https://github.com/punkpeye/mcp-remote), based on upstream commit `71cadf3aaa935608d5e14d472a59e9583ebb9505`. The upstream bridge and license remain in this fork. Its original instructions are in [UPSTREAM-README.md](docs/UPSTREAM-README.md).

## Run locally

Requires Node.js 22.12 or newer and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm --dir web install --frozen-lockfile
pnpm build
pnpm start
```

On a Mac with dependencies already installed and the build complete, open **Start Customer MCP Router.command** in this folder. The dashboard runs at `http://127.0.0.1:4773`. Keep its terminal open while managing connections. Existing MCP client processes do not depend on the dashboard remaining open.

## Connect a customer

1. Select **Add customer**. Enter its name and business label. Copy its organization ID from its Glide URL, such as the ID after `/o/` in `https://os.glideapps.dev/o/ORG_ID/projects`.
2. Open the customer and select **Connect**. Finish Glide sign-in and choose that organization. The router reads `project_list` and checks its server-owned organization citation before showing **Verified**.
3. Enter the full path to the customer's local project. Preview the generated Claude and Codex settings. Review any warnings about existing Glide connections, then apply.
4. Open a fresh Claude Code or Codex session in that project. Codex requires the project to be trusted. Claude may ask to approve the project's MCP entry. These are local project approvals; they do not repeat Glide sign-in. In T3, open that project and start a fresh provider session.

**Connect** starts a fresh authorization for only the selected customer. It invalidates older router sessions for that customer. **Check connection** reuses the saved grant and never opens a new sign-in. Refresh of an existing grant happens automatically.

Project settings use absolute paths to this checkout and Node. If you move the checkout or replace the Node installation, review and update those entries. Existing differing `customer-glide` entries are refused to prevent silent rebinding. A separate Git worktree needs its own binding; a copied entry still points at the original checkout and must be reviewed before reuse.

## What it owns

- A customer registry, organization expectations, and project bindings in `~/.mcp-customer-router/`.
- Separate private credential directories and stable OAuth callback ports for each customer.
- A `customer-glide` entry in `.mcp.json` and `.codex/config.toml` for each project you explicitly bind. Other settings are preserved. Existing files receive private backups.
- One bridge process per active client. Claude and Codex read the same customer's saved credential store while keeping independent protocol connections.

The browser receives generated snippets only. Existing configuration content and OAuth credentials stay out of API responses. The local dashboard checks its host, browser origin, and session token. It binds only to `127.0.0.1`.

The MVP supports `https://mcp.glideapps.dev/mcp`. Loopback HTTP servers exist for automated tests. It blocks tools if organization identity is absent or differs from the saved expectation. It also stops older sessions when a new customer sign-in begins. A timeout or cancellation does not prove that a remote write was rolled back; check the result before retrying it.

## Limits

This provides saved-connection separation under one operating-system account. An agent with broad file access under that account can reach other credential directories. Strong isolation between untrusted tenants needs a separate execution boundary.

Existing global or project Glide connections can still be available to agents. The router reports detected entries for review and does not disable them automatically. T3's own provider override settings and organization policies can also affect effective configuration. Verify the active MCP list in each client.

The dashboard must be open to manage customers. Work runs on the Mac and stops when its execution process is unavailable. This release has no hosted execution or scheduler. Credentials use private files, not Mac Keychain. Removing a customer entry retains its protected credential files for recovery and does not revoke the grant at Glide; removal is blocked while projects remain bound.

## Commands

```sh
node dist/router-cli.js --help
node dist/router-cli.js list
node dist/router-cli.js dashboard --port 4774
node dist/router-cli.js connect --customer CUSTOMER_UUID
node dist/router-cli.js check --customer CUSTOMER_UUID
```

Use `--home /absolute/path` for an isolated registry. Keep data directories outside Git. The `serve` command is generated into client configuration and requires a matching saved project binding and project working directory.

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
