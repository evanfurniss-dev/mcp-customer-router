# Dashboard UI sources and verification

Reviewed 2026-10-18. This document covers `web/` only.

## Foundation

React 19.3.1, TypeScript 5.9.3, Vite 8.3.4, Tailwind CSS 4.3.3 and Base UI 1.9.0. Dependencies are pinned in `web/package.json` and resolved in its independent `pnpm-lock.yaml`. The app uses the shadcn copy-and-own structure, `components.json`, CSS variable tokens, and `src/components/ui` ownership. No external font requests or runtime CDN assets are used.

There were no existing frontend primitives in this repository. COSS and shadcn Base UI were compared for each common primitive. COSS fits the requested React/Tailwind v4 stack, provides loading behavior, and keeps one Base UI family. shadcn Base UI provides the same ownership model and compatible dialog semantics; adding a parallel primitive family would add no value for this interface. A grid package, router package, animation package, and form package were unnecessary for this two-panel local admin flow.

## Chosen sources and alternatives

| Owned file                          | Source inspected                                                                                                | Alternative inspected                                                      | Adaptation                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web/src/components/ui/button.tsx`  | [COSS Button](https://coss.com/ui/docs/components/button), [registry source](https://coss.com/ui/r/button.json) | [shadcn Base UI Button](https://ui.shadcn.com/docs/components/base/button) | Local imports; visible labels; 40px minimum button height; original loading and disabled behavior.                                                                                         |
| `web/src/components/ui/input.tsx`   | [COSS Input](https://coss.com/ui/docs/components/input), [registry source](https://coss.com/ui/r/input.json)    | [shadcn Base UI Input](https://ui.shadcn.com/docs/components/base/input)   | Native field labels and descriptions; touch sizing; clear focus state.                                                                                                                     |
| `web/src/components/ui/dialog.tsx`  | [COSS Dialog](https://coss.com/ui/docs/components/dialog), [registry source](https://coss.com/ui/r/dialog.json) | [shadcn Base UI Dialog](https://ui.shadcn.com/docs/components/base/dialog) | Base UI modal, title, description, Escape and focus handling retained. Native scrolling replaces the extra ScrollArea component. Visible Cancel controls; no icon-only close control used. |
| `web/src/components/ui/badge.tsx`   | [COSS Badge](https://coss.com/ui/docs/components/badge), [registry source](https://coss.com/ui/r/badge.json)    | [shadcn Base UI Badge](https://ui.shadcn.com/docs/components/base/badge)   | Text and decorative icons identify every state; color carries no unique meaning.                                                                                                           |
| `web/src/components/ui/card.tsx`    | [COSS Card](https://coss.com/ui/docs/components/card), [registry source](https://coss.com/ui/r/card.json)       | [shadcn Base UI Card](https://ui.shadcn.com/docs/components/base/card)     | Local imports, compact connection panel.                                                                                                                                                   |
| `web/src/components/ui/spinner.tsx` | [COSS Spinner registry](https://coss.com/ui/r/spinner.json)                                                     | shadcn Button spinner composition                                          | Used by the owned COSS button. Reduced-motion rules suppress rotation.                                                                                                                     |

Source pages and their code/variant contracts were inspected live. Registry JSON supplied the exact copied source. Installation used manual source copying, then `pnpm --dir web install`; no registry CLI changed the root project. The native business select, checkbox, labels, form, and details elements use platform semantics. Customer rows and detail sections compose these owned primitives.

[COSS styling](https://coss.com/ui/docs/styling) supplied the semantic-token and portal-isolation contract. The application root uses `isolation: isolate` and the body uses relative positioning. The interface uses system fonts, limited motion, and narrow-width reflow.

## Usage terms

The [COSS repository README](https://github.com/cosscom/ui#license) specifies MIT for `apps/ui/` and `apps/origin/`; other directories use AGPL. The copied public registry lives under `apps/ui/`. The AGPL `@coss/ui` package was not installed or copied. MIT license text is retained at `web/licenses/COSS-REGISTRY-MIT.txt`. Base UI, React, and the other dependencies retain their own package licenses.

## Behavior and access

The UI obtains a session token from `/api/session` and keeps it in memory. All API requests include `x-router-token`. It shows backend data without real-customer sample records or simulated success. A saved customer is unconnected until the backend reports a verified organization. Jobs are polled while active; failed state reads keep a visible error and disable mutations. A running connection job can expose an “Open Glide sign-in” link. The link comes from the job data, survives page reload, opens a separate tab with `noopener noreferrer`, and is removed when the job ends. The interface shows preparation progress until the provider supplies its authorization URL.

Hash links open customer records and preserve search/filter state. A project preview is scoped to the selected customer and cleared when the path changes. Apply requires a verified identity and acknowledgment of all supplied warnings. Generated snippets are labeled as partial file entries. Success means settings were saved; the UI instructs the user to start a new client session and check project trust and tool identity. Removal describes the saved entry and retained authentication files accurately.

**Choose folder** reuses the local COSS Button and Input in `web/src/App.tsx`. It opens the native macOS folder dialog through the authenticated local API. A successful choice fills the exact returned path and clears an older preview. Cancel keeps the path and preview. Project controls are disabled while the dialog is open; focus returns to the chooser button afterward. Manual path entry remains available. Choosing a folder does not apply settings.

## Verification

- `pnpm --dir web install`: passed.
- `pnpm --dir web build`: passed; strict TypeScript check and Vite production build write `web/dist`.
- Source checks: native links, visible labels, disabled pending mutations, stable live region, Base UI modal focus handling, no external fonts, reduced motion, and 320px responsive rules present.
- Real browser verification: passed in headless Chromium against `http://127.0.0.1:4774`, using the isolated data home `/private/tmp/customer-router-ui.74dHun`. CUA was tried first; the in-app browser was unavailable and the Chrome extension timed out. The bundled Playwright runtime ran the local interface checks.
- Tested at 1440×1000 and 320×800: empty onboarding, customer save, case-insensitive search, business filter, hash navigation, modal initial focus, keyboard containment, Escape return focus, and narrow layout. Page width stayed 320px at the narrow viewport; long generated code scrolls within its own panel.
- Check without credentials returned `unverified` and the UI showed “Not connected.” No Connect action or Glide sign-in was performed.
- Project preview showed existing Glide warnings and disabled Apply while identity was unverified. For the Apply path only, `RegistryStore.recordCheck` seeded an explicitly synthetic verified identity for `org-a`. Apply still required acknowledgment of warnings. The generated JSON and TOML were read back; their customer, home, executable, and project arguments matched, unrelated entries remained intact, and the registry binding persisted. A second preview showed no file changes; removal was disabled for the bound customer.
- Browser tests found and fixed missing focus restoration on the controlled Add customer dialog. Customer/business length limits now match the backend. Dialog footer clipping and hidden skip-link painting were adjusted after screenshot review. No browser page errors were observed.
- Evidence: `ui-preview-results.json`, `ui-apply-results.json`, and desktop/mobile screenshots in the isolated test folder above. The verification fixture does not establish live Glide identity, OAuth refresh, real client configuration loading, or production isolation.

### Sign-in link regression check

The built interface was checked with intercepted synthetic API responses in Chromium at desktop and 320px widths. Tests covered preparation text, a focusable anchor, `target`/`rel` attributes, survival after reload, removal after completion or failure, and ordinary identity checks without sign-in prompts. No Connect action was clicked and no request reached Glide. The synthetic authorization URL used `example.invalid`. Results and screenshots are saved under `/private/tmp/router-sign-in-ui-results.json`, `/private/tmp/router-sign-in-desktop.png`, and `/private/tmp/router-sign-in-320.png`.

### Folder-picker browser checks

Chromium checked the built interface with synthetic picker responses at 1440px and 320px widths. Keyboard activation, focus restoration, cancellation preserving the current preview, selection clearing the old preview, disabled Apply during selection, error retry, and exact path submission passed. The selected fixture path ends in a space to detect accidental trimming. No Apply or Glide request was made. Evidence: `/private/tmp/router-folder-ui-results.json` and `/private/tmp/router-folder-{desktop,mobile}.png`. These intercepted responses verify frontend behavior; native dialog verification is recorded separately in `VERIFICATION.md`.
