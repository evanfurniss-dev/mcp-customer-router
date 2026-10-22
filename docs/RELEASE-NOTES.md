Customer MCP Router 0.2.0 adds a guided setup and control over existing Glide connections.

- A first-launch walkthrough explains saved customer connections and project folders. The info button opens it again. Example screens appear beside each step, with dark mode and small-screen support.
- **Client setup** provides guides for T3 Code, Claude Code CLI, the Claude app's local Code tab, Codex app, Codex CLI, and local Conductor workspaces.
- **Preview config** lists other detected Glide connections with **Remove** and **Ignore** choices. Removal happens only when you apply. The router shows the scope, saves private backups, and stops if settings changed after preview.
- The repository includes a client guide, changelog, contribution guide, and security policy. The Homebrew archive includes these documents and the dashboard image.

Install:

```sh
brew install evanfurniss-dev/tap/mcp-customer-router
mcp-customer-router service install --open
```

Upgrade:

```sh
brew update
brew upgrade evanfurniss-dev/tap/mcp-customer-router
mcp-customer-router service restart
mcp-customer-router open
```

Start fresh agent sessions after upgrading. Existing customer records, saved sign-ins, and project bindings stay in `~/.mcp-customer-router/` by default. This release does not apply connection removals automatically.

Package checks use temporary settings. They check Remove/Ignore behavior, backups, the packaged dashboard, and operation after an upgrade removes the old installation. Claude app and Conductor instructions are based on their documentation; live router trials for those clients remain open. A clean macOS account with real Glide sign-in and Intel Mac operation also remain separate acceptance checks.

The router supports Glide's MCP endpoint and separates customer connections under one OS account. Its local stdio entries require this Mac to run. They do not provide a security sandbox or hosted execution.
