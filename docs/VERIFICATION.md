# MVP verification

Verified on 2026-10-19. This fork starts at mcp-remote commit `71cadf3aaa935608d5e14d472a59e9583ebb9505`.

## Acceptance criteria

The build must save one authorization per customer, share it between Claude Code and Codex, and bind each local project to one expected Glide organization. A missing or different organization must block tool access. A new sign-in must invalidate older sessions for that customer. A failed response to a write must not cause automatic replay. Configuration changes must preserve unrelated entries and detect changes after preview. Secrets must stay out of dashboard responses and generated settings.

## Observed results

| Check                  | Result                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Automated suite        | 663 tests passed across 28 files. This includes the inherited upstream suite and router tests.                                                                                                                                                                                                         |
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

## Browser handoff repair

The first user Connect attempt waited for authorization without displaying a browser. The macOS opener failed inside the coding-agent process sandbox and succeeded outside it. Raw OAuth log suppression also hid the fallback URL from the dashboard.

Connect now publishes the prepared sign-in URL through a dedicated child IPC channel after authorization checks. The dashboard shows **Open Glide sign-in** while the job is active. The URL stays in memory, is removed on completion, cancellation or generation change, and is hidden when dashboard refresh fails. Job text says that sign-in is being prepared until the URL is ready. The running router was restarted outside the process sandbox; a fresh live Glide attempt returned a validated sign-in link.

A real child fixture completed authorization through the IPC link with browser launch blocked. Additional tests cover wrong endpoints/callbacks, stale generations, late IPC after completion, and non-interactive check/serve modes. Browser tests verified the manual link at desktop and 320px widths, including reload, completion, failure and lost dashboard access. Real consent and organization selection remain user actions.

## Single-character organization IDs

The original validators required at least two characters in both saved expectations and returned citation paths. They now accept one through 128 allowed characters, with IDs kept as strings. Regression tests save and reload fixture organization `1`, verify its citation and real SDK connection, reject empty IDs, and retain mismatch blocking between separate customers.

An existing live authorization passed the identity check after the saved expectation was corrected to the verified organization. The check reused that authorization without a new sign-in. The local registry was backed up before the correction; credential files were preserved. This verifies one live connection. Multi-organization client transfer and long-running refresh still require the acceptance checks below.

## Native project folder picker

The dashboard now opens a macOS folder picker through an authenticated local POST action. The command is fixed and receives no request-supplied script text. It returns a canonical directory path, or null on cancellation. One picker can run at a time; it is stopped when the browser request closes or after 120 seconds. Choosing a folder writes no project settings or registry records.

Automated checks cover selection, cancellation, invalid results, safe errors, timeout, unsupported operating systems, session protection, concurrent requests, and request cancellation followed by a new picker. Frontend browser checks preserve trailing spaces in selected paths, clear stale previews only after selection, preserve previews on Cancel, restore focus, disable Apply while picking, and fit a 320px viewport.

A click in Chromium against the running local dashboard opened the native **Choose a Folder** window. A screenshot of that window was inspected at `/private/tmp/router-folder-native.png`; closing the test page removed it. No project settings were applied. Native button selection and cancellation were not automated because desktop-control access was unavailable; those returned outcomes were covered with fixture responses. Browser results are recorded in `/private/tmp/router-folder-ui-results.json`.

## Claude startup discovery repair

A user session in T3 Code 0.0.45 exposed customer guidance resources but no customer tools. Its transcript confirmed failed tool searches. It did not retain the transport diagnostics needed to prove the original cause.

Three initialization-only checks with native Claude Code 2.1.287 against the pre-fix build at `f18f014` all eventually loaded 126 customer tools. However, the router delayed its answer to Claude's `server/discover` probe beyond the installed client's 3-second timeout. In one check, the late answer arrived after legacy initialization, producing `Received a response for an unknown message ID` for `server-discover-probe-1` and a dropped-connection log. This confirms an intermittent protocol error; it does not reproduce the original resources-only state.

Serve mode now starts stdio before network identity verification and immediately rejects the optional discovery probe with `-32601`, directing the client to `initialize`. The existing proxy still negotiates the upstream protocol. Other client messages stay in a bounded queue until organization verification succeeds. A close, parse error, queue overflow or mismatched identity prevents release. Cancellation removes its queued request. Discovery probes remain local after verification.

Three comparable native Claude checks through T3's bundled Agent SDK returned the discovery rejection in 303, 336 and 344 milliseconds. Each loaded 126 tools, including `project_list` and `auth_whoami`, with zero unknown-ID errors or dropped-connection logs. The saved customer authorization was reused. A separate SDK readback returned the expected organization citation and zero projects through the configured `customer-glide` route. No new login or customer write was needed.

The added automated tests cover held identity verification, discovery response before release, successful handshake and tool execution after release, mismatched identity with zero forwarded user requests, queued cancellation, bounded input, and shutdown. The full 644-test suite, static checks, Knip and bridge build passed. An independent code review found no blocking defect.

These native checks used only the customer server and sent no user prompt or model request. They do not prove tool selection in a normal T3 session with all configured servers. T3 0.0.45 marks its session ready before waiting for MCP inventory. A fresh T3 chat in the bound project is still required to verify the user path. Timing differences between whole runs do not establish a general latency improvement. Long-running connection durability was not tested.

## Persistent macOS service and compact UI

The dashboard now supports `service install`, `status`, `start`, `stop`, `restart`, and `uninstall`, plus `open`. Installation creates a per-user LaunchAgent and a `~/.local/bin/mcp-customer-router` shortcut. The job uses absolute executable paths, binds to loopback, starts at login, and uses `KeepAlive` to recover after exits. Stop disables the job until an explicit start. Removal preserves customer data. An occupied port, unrelated file or symbolic link blocks installation without killing its owner or overwriting the file.

The implementation follows the installed macOS 27 `launchctl` and `launchd.plist` manuals. Apple's [LaunchAgent guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) describes the per-user login lifecycle; that guide is archived, so current local manual behavior takes precedence. This service is available while the user is logged in and the Mac is awake. It does not provide cloud execution.

Nineteen focused tests cover command ordering, readiness, literal paths and shell arguments, private file modes, refusal of unrelated files and occupied ports, and preserved customer data. Live testing found that `bootout` can return before macOS removes the service. The implementation now waits for removal before starting it again; a regression test holds that transition and verifies that startup cannot proceed early.

On the user's Mac, installation, CLI status, stop, start and restart passed. The same CLI worked with a clean environment containing only HOME and a minimal PATH. The plist passed `plutil -lint`; its mode and log modes were 0600, the log directory and shortcut modes 0700. A controlled SIGTERM to the idle managed service produced a new listening process and healthy HTTP response after approximately 330 ms, without issuing a manual start. All five customer records remained present and the registry SHA-256 was unchanged. There were no model requests, new sign-ins or customer data writes. Login after a full reboot was not tested.

The UI removes eyebrow headings, avatars, onboarding steps and repeated descriptions. It uses compact neutral lists and forms; extra setup details are collapsed. Duplicate business names and matching observed organization IDs are omitted. A mismatch still shows both IDs. All connection, folder-picker, configuration-warning and removal protections remain. The built page was inspected in the real in-app browser against the managed service. Synthetic browser tests cover the form and modal paths, search and filter state, sign-in lifecycle, configuration safeguards and folder selection at desktop and 320px widths. See [UI-SOURCES.md](UI-SOURCES.md) for source and evidence details.

The full suite passed 663 tests across 28 files. Formatting, lint, TypeScript, Knip, bridge build and web build passed. The running service uses the built local checkout; moving or deleting that checkout requires reinstalling the service and updating any project configuration that references it.

## Live acceptance still required

Use two test organizations before migrating customer work:

1. Add both organizations and connect each once. Confirm that each shows its expected organization. Choose the wrong organization in a separate trial and confirm that it is blocked.
2. Bind separate disposable projects. Start fresh Claude Code and Codex sessions in each, approve/trust the local entries, and use a read-only project listing. Both clients must see the expected organization without another Glide login.
3. Repeat through the installed T3 provider adapters. Confirm effective MCP lists and check that provider overrides do not add a different Glide connection.
4. Reconnect one customer while an older client is open. That client must fail until restarted. Confirm the other customer still works.
5. Test refresh and revocation with the test organizations. Confirm that expired access either refreshes in the same customer store or stops with a clear sign-in requirement.

Automated isolation tests use synthetic identities. The live checks above cover one saved customer route. T3 model execution, overnight refresh and 30-organization load trials remain unrun. No customer business data was changed. This startup repair changed no Claude/Codex project configuration. This release has no scheduler or cloud execution. Local customer credentials use protected files; Mac Keychain storage is future work.
