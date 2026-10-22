# Client setup guide

Checked on 21 October 2026. The dashboard offers instructions for six clients. Selecting a client shows its guide; it does not install an application, sign in to a model provider, or launch a session.

## Shared setup

The router writes a `customer-glide` stdio entry to the selected folder’s `.mcp.json` and `.codex/config.toml`. It passes absolute executable, customer, project, and router-data paths. These entries reuse the customer’s saved Glide sign-in. Each model provider still needs its own account.

Source: `src/router/project-config.ts`, `generateProjectConfigEntry`. The `serve` command in `src/router-cli.ts` checks the saved binding and rejects a process started outside that folder or its descendants. A copied configuration file does not bind another worktree. Apply setup to the actual working folder before using it. Local client configuration is not an operating-system security boundary.

## Client scope and sources

| Client          | Guide scope                                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T3 Code         | Local Claude Code or Codex provider; same customer folder               | [Claude provider](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md), [Codex provider](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md). T3 uses provider configuration. Installed T3 Code Beta is version 0.1.0. Its `codexThreadRuntimeParams` passes the thread cwd and adds the T3 MCP server. Other T3 providers need their own compatibility checks. |
| Claude Code CLI | Start `claude` in the bound folder; approve project MCP; inspect `/mcp` | [MCP configuration and approvals](https://code.claude.com/docs/en/mcp). Project MCP lives in `.mcp.json`; project trust and approval can affect whether tools load.                                                                                                                                                                                                                                             |
| Claude app      | Local Code tab                                                          | [Shared configuration](https://code.claude.com/docs/en/desktop#shared-configuration). The Code tab reads project `.mcp.json`. A same-name entry in `claude_desktop_config.json`, or a user-scope stdio entry in `~/.claude.json`, takes precedence in local Code sessions. The router does not configure Claude chat or Cowork.                                                                                 |
| Codex app       | Local project on this Mac                                               | [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp#connect-codex-to-an-mcp-server), [configuration trust](https://learn.chatgpt.com/docs/config-file/config-basic). Local Codex clients share configuration. Project `.codex/config.toml` loads only for trusted projects.                                                                                                                           |
| Codex CLI       | Start `codex` in the bound folder; inspect `/mcp`                       | Same Codex sources. After setup changes, use a new session to load the configuration.                                                                                                                                                                                                                                                                                                                           |
| Conductor       | Local workspace running Claude Code or Codex                            | [MCP configuration](https://www.conductor.build/docs/reference/mcp), [Git worktrees](https://www.conductor.build/docs/concepts/git-worktrees). Conductor loads agent-specific configuration and creates a separate worktree for each workspace. Bind that workspace’s folder, then start a new agent session and refresh MCP status.                                                                            |

The Mac-local stdio entries do not supply an executable or credentials to a cloud workspace. Remote execution needs a separate installation and connection design.

## Verification limits

The six guides were checked against current official documentation and the router’s current source. The installed T3 version and Codex working-directory path were read from its packaged source. Existing T3 use has been reported by the user, and prior checks in this workspace verified the router bridge from a configured folder.

This guide update does not establish a new end-to-end run for every client. Claude desktop Code and Conductor have not received a live router trial as part of this change. Their steps are documentation-based. Official documentation and T3’s `main` branch can change after this date.

## Claude chat integration boundary

Claude desktop chat can run local MCP servers through its desktop configuration. It does not get this router’s per-folder setup from `.mcp.json`. Supporting it safely would require a separate client configuration flow and a way to start the bridge in the bound folder, with a clear customer selection model. Adding a global router entry without those controls would undermine the folder-based setup. The current guide therefore directs Claude app users to the local Code tab.
