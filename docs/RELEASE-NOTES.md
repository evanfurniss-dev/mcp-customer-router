Customer MCP Router 0.2.1 selects **Ignore** for existing connections by default.

Each new configuration preview starts with **Ignore** selected for every detected existing connection. You can apply the router configuration without selecting each row. Choose **Remove** explicitly for an entry you want to remove, then select **Apply and remove N**.

The router still validates every submitted choice, saves private backups before changing settings, and stops if settings changed after preview.

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

Claude app and Conductor instructions are based on their documentation; live router trials for those clients remain open. A clean macOS account with real Glide sign-in and Intel Mac operation also remain separate acceptance checks.

The router supports Glide's MCP endpoint and separates customer connections under one OS account. Its local stdio entries require this Mac to run. They do not provide a security sandbox or hosted execution.
