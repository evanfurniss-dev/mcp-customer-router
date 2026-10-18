# MVP verification

Verified on 2026-10-18. This fork starts at mcp-remote commit `71cadf3aaa935608d5e14d472a59e9583ebb9505`.

## Acceptance criteria

The build must save one authorization per customer, share it between Claude Code and Codex, and bind each local project to one expected Glide organization. A missing or different organization must block tool access. A new sign-in must invalidate older sessions for that customer. A failed response to a write must not cause automatic replay. Configuration changes must preserve unrelated entries and detect changes after preview. Secrets must stay out of dashboard responses and generated settings.

## Observed results

| Check                  | Result                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Automated suite        | 604 tests passed across 24 files. This includes the inherited upstream suite and router tests.                                                                                                                                                                                                         |
| Static checks          | Root formatting, lint, TypeScript and Knip passed. Frontend strict TypeScript passed.                                                                                                                                                                                                                  |
| Build                  | Bridge and dashboard production builds passed.                                                                                                                                                                                                                                                         |
| Shared authorization   | Two MCP clients used the same temporary customer store, with one refresh and independent protocol handshakes.                                                                                                                                                                                          |
| Customer separation    | Two organizations at the same MCP URL kept separate credentials. A mismatched organization blocked tools. Revoked grants and missing credentials did not start interactive login.                                                                                                                      |
| Explicit login         | A local OAuth fixture exercised client registration, browser callback, token exchange, identity check and saved issuer. The browser action was simulated against that fixture.                                                                                                                         |
| Reconnect              | A new generation blocked older sessions and prevented stale refresh writes from replacing the new grant.                                                                                                                                                                                               |
| OAuth issuer           | Tests sent zero refresh requests to a changed authorization server or a cross-origin token endpoint. An unstamped saved grant was rejected. Issuer stamps survived explicit login and proactive refresh.                                                                                               |
| Uncertain write result | A fixture accepted a write and then dropped its response, and separately returned a session failure. Each case executed exactly one write. The client received an unknown-outcome error; later reads worked.                                                                                           |
| Configuration          | JSON and TOML preservation, duplicate alias refusal, preview conflicts, symlink checks, backups, two-file rollback and registry-failure rollback passed. Concurrent job limits were tested.                                                                                                            |
| Local API              | Host, origin, session token, request limits and omission of existing configuration secrets passed.                                                                                                                                                                                                     |
| Browser                | Headless Chromium passed desktop 1440×1000 and narrow 320×800 flows against the real local backend. Add, search, filter, navigation, dialog focus, preview, warning acknowledgment and Apply were exercised. Generated files were read back. No page errors or horizontal page overflow were observed. |
| Built CLI              | Add/list/check passed against the compiled entry points and a temporary registry. Missing credentials returned `unverified`, the result persisted, and the data directory had mode 0700.                                                                                                               |
| Installed clients      | Codex CLI 0.162.1 listed the generated stdio entry in an isolated trusted project. Claude Code 2.1.287 loaded it from project configuration and reported Pending approval. No model request was made.                                                                                                  |

Browser Apply testing used an explicitly synthetic verified identity in a temporary registry. It proves the local configuration path; it does not prove a live Glide authorization. Details and UI source licenses are in [UI-SOURCES.md](UI-SOURCES.md).

The local environment used Node 25.8.1 and pnpm 11.25.0. The repository declares Node 22.12 or newer. CI is configured for Node 22 and 24; local success alone does not establish a CI result.

## Source and compatibility limits

- [mcp-remote source](https://github.com/punkpeye/mcp-remote/tree/71cadf3aaa935608d5e14d472a59e9583ebb9505) provides OAuth storage, refresh coordination and protocol forwarding. Each router connection runs in its own process because the inherited credential directory is process-wide.
- [Codex MCP documentation](https://developers.openai.com/codex/mcp) defines project `.codex/config.toml`, trusted projects and stdio command/arguments.
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) defines project `.mcp.json` and approval. Client configuration loading was checked with the installed versions above.
- MCP SDK client/core/server 2.3.1 is pinned in the lockfile. The router also checks issuer metadata before inherited proactive refresh. See [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h).
- Live public [authorization metadata](https://mcp.glideapps.dev/.well-known/oauth-authorization-server) and [resource metadata](https://mcp.glideapps.dev/.well-known/oauth-protected-resource/mcp) matched the supported origin on the verification date. Issuer, token, authorization and registration endpoints used `https://mcp.glideapps.dev`. The deployed authenticated tool version was not established.
- Glide identity depends on the server-owned `project_list` structured citation matching `https://os.glideapps.dev/o/EXPECTED_ORG/projects`. Unsupported or changed responses block access until reviewed.

The router isolates saved connections and validates project routing. Processes with broad access under the same Mac account can read other customer files. Existing global MCP entries and provider overrides remain available unless you remove or narrow them. The dashboard reports detected Glide entries for review.

## Dependency review

The final root audit reported zero critical, high or moderate findings and one low finding. Root production dependencies and frontend production dependencies reported zero findings. A full audit also covers the MCP SDK, which this fork bundles from development dependencies.

The remaining [esbuild advisory GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) affects its Windows development server. The router serves the built dashboard through Express on loopback and does not use that development server. esbuild 0.27.7 remains within tsup 8.5.1's supported range; reassess when tsup supports the patched esbuild line. Audit results describe the registry response on this verification date, not a full security assessment.

Vitest 4.1.12 and oxfmt 0.73.0 passed the existing suite without product or test changes. Explicit Vite 6.4.4 and PostCSS 8.5.31 development dependencies resolve stale peer dependencies. Root and frontend frozen installs passed independently; no workspace file was added.

## Live acceptance still required

Use two test organizations before migrating customer work:

1. Add both organizations and connect each once. Confirm that each shows its expected organization. Choose the wrong organization in a separate trial and confirm that it is blocked.
2. Bind separate disposable projects. Start fresh Claude Code and Codex sessions in each, approve/trust the local entries, and use a read-only project listing. Both clients must see the expected organization without another Glide login.
3. Repeat through the installed T3 provider adapters. Confirm effective MCP lists and check that provider overrides do not add a different Glide connection.
4. Reconnect one customer while an older client is open. That client must fail until restarted. Confirm the other customer still works.
5. Test refresh and revocation with the test organizations. Confirm that expired access either refreshes in the same customer store or stops with a clear sign-in requirement.

No real Glide login, customer mutation, T3 model run, overnight refresh test or 30-organization load trial was performed. No existing Claude/Codex customer configuration was changed. This release has no scheduler or cloud execution. Local customer credentials use protected files; Mac Keychain storage is future work.
