First Homebrew package for Customer MCP Router.

```sh
brew install evanfurniss-dev/tap/mcp-customer-router
mcp-customer-router service install --open
```

Includes the local dashboard, separate saved Glide customer connections, and project configuration for Claude Code and Codex. Homebrew supplies Node. Stable installation paths keep new project connections usable across package upgrades.

After an upgrade, run `mcp-customer-router service restart` and start fresh Claude Code/Codex sessions. Before removing the package, run `mcp-customer-router service uninstall`. Saved customer data stays on disk.

This is an early macOS release. Package checks use temporary data and local fixtures. A fresh user's real Glide sign-in and both client applications remain a separate acceptance check. The router supports Glide's MCP endpoint; it provides connection separation under one OS account. It does not provide a security sandbox or hosted execution.
