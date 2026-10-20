# Dashboard UI sources and verification

Reviewed 2026-10-19. This document covers `web/` only.

## Foundation

React 19.3.1, TypeScript 5.9.3, Vite 8.3.4, Tailwind CSS 4.3.3 and Base UI 1.9.0. Dependencies are pinned in `web/package.json` and resolved in its independent `pnpm-lock.yaml`. The app uses the shadcn copy-and-own structure, `components.json`, CSS variable tokens, and `src/components/ui` ownership. No external font requests or runtime CDN assets are used.

There were no existing frontend primitives in this repository. COSS and shadcn Base UI were compared for each common primitive. COSS fits the requested React/Tailwind v4 stack, provides loading behavior, and keeps one Base UI family. shadcn Base UI provides the same ownership model and compatible dialog semantics; adding a parallel primitive family would add no value for this interface. A grid package, router package, animation package, and form package were unnecessary for this two-panel local admin flow.

## Chosen sources and alternatives

| Owned file                          | Source inspected                                                                                                | Alternative inspected                                                      | Adaptation                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web/src/components/ui/button.tsx`  | [COSS Button](https://coss.com/ui/docs/components/button), [registry source](https://coss.com/ui/r/button.json) | [shadcn Base UI Button](https://ui.shadcn.com/docs/components/base/button) | Local imports; visible labels; 34px desktop controls and 44px coarse-pointer controls; original loading and disabled behavior.                                                             |
| `web/src/components/ui/input.tsx`   | [COSS Input](https://coss.com/ui/docs/components/input), [registry source](https://coss.com/ui/r/input.json)    | [shadcn Base UI Input](https://ui.shadcn.com/docs/components/base/input)   | Native field labels and descriptions; touch sizing; clear focus state.                                                                                                                     |
| `web/src/components/ui/dialog.tsx`  | [COSS Dialog](https://coss.com/ui/docs/components/dialog), [registry source](https://coss.com/ui/r/dialog.json) | [shadcn Base UI Dialog](https://ui.shadcn.com/docs/components/base/dialog) | Base UI modal, title, description, Escape and focus handling retained. Native scrolling replaces the extra ScrollArea component. Visible Cancel controls; no icon-only close control used. |
| `web/src/components/ui/badge.tsx`   | [COSS Badge](https://coss.com/ui/docs/components/badge), [registry source](https://coss.com/ui/r/badge.json)    | [shadcn Base UI Badge](https://ui.shadcn.com/docs/components/base/badge)   | Text identifies every state; color carries no unique meaning. Labels can wrap.                                                                                                             |
| `web/src/components/ui/card.tsx`    | [COSS Card](https://coss.com/ui/docs/components/card), [registry source](https://coss.com/ui/r/card.json)       | [shadcn Base UI Card](https://ui.shadcn.com/docs/components/base/card)     | Retained local primitive; the current detail view uses plain sections.                                                                                                                     |
| `web/src/components/ui/spinner.tsx` | [COSS Spinner registry](https://coss.com/ui/r/spinner.json)                                                     | shadcn Button spinner composition                                          | Used by the owned COSS button. Reduced-motion rules suppress rotation.                                                                                                                     |

Source pages and their code/variant contracts were inspected live. Registry JSON supplied the exact copied source. Installation used manual source copying, then `pnpm --dir web install`; no registry CLI changed the root project. The native business select, checkbox, labels, form, and details elements use platform semantics. Customer rows and detail sections compose these owned primitives.

[COSS styling](https://coss.com/ui/docs/styling) supplied the semantic-token and portal-isolation contract. The application root uses `isolation: isolate` and the body uses relative positioning. The interface uses system fonts, limited motion, and narrow-width reflow.

## Usage terms

The [COSS repository README](https://github.com/cosscom/ui#license) specifies MIT for `apps/ui/` and `apps/origin/`; other directories use AGPL. The copied public registry lives under `apps/ui/`. The AGPL `@coss/ui` package was not installed or copied. MIT license text is retained at `web/licenses/COSS-REGISTRY-MIT.txt`. Base UI, React, and the other dependencies retain their own package licenses.

## Behavior and access

The UI obtains a session token from `/api/session` and keeps it in memory. All API requests include `x-router-token`. It shows backend data without real-customer sample records or simulated success. A saved customer is unconnected until the backend reports a verified organization. Jobs are polled while active; failed state reads keep a visible error and disable mutations. A running connection job can expose an “Open Glide sign-in” link. The link comes from the job data, survives page reload, opens a separate tab with `noopener noreferrer`, and is removed when the job ends. The interface shows preparation progress until the provider supplies its authorization URL.

Hash links open customer records and preserve search/filter state. A project preview is scoped to the selected customer and cleared when the path changes. Apply requires a verified identity and acknowledgment of all supplied warnings. Generated snippets are labeled as partial file entries. Success means settings were saved; the UI instructs the user to start a new client session and check project trust and tool identity. Removal describes the saved entry and retained authentication files accurately.

**Choose folder** reuses the local COSS Button and Input in `web/src/App.tsx`. It opens the native macOS folder dialog through the authenticated local API. A successful choice fills the exact returned path and clears an older preview. Cancel keeps the path and preview. Project controls are disabled while the dialog is open; focus returns to the chooser button afterward. Manual path entry remains available. Choosing a folder does not apply settings.

## Initial verification (2026-10-18)

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

## Compact utility interface (2026-10-19)

This revision reused the owned Button, Input, Badge, and Base UI Dialog. It added no dependency, external component, or font. App.tsx composed those primitives with the existing native form, select, checkbox, links, and details elements. The document title at this revision was “MCP customer router.”

Removed the logo, avatar initials, eyebrow labels, onboarding steps, large card shell, persistent setup paragraphs, and duplicate success messages. The sidebar shows search, business filter, customer name, and status. Business text appears when it differs from the customer name. Details show the expected organization, endpoint, latest check, and actions. A different observed organization stays visible with the mismatch error. Saved project paths and config review remain in the main flow. Client instructions, customer ID, callback port, and the latest job are inside a native disclosure. No service state was added.

### Foundation and component review

- Neutral CSS tokens, system fonts, compact spacing, and explicit text states replace decorative styling. The status badge grows when its label wraps.
- Native customer links retain the hash route and search/filter state. Record and preview headings receive focus after navigation. Focus outlines and forced-color support remain.
- The Add customer dialog retains field labels, length limits, keyboard containment, Escape, and return focus. Destructive confirmation and blocked removal for bound projects remain.
- Config review keeps generated snippets, change indicators, identity requirements, and warning acknowledgment. Native folder selection retains exact paths, cancellation, error recovery, and focus return.
- Existing connection jobs retain loading/disabled states and sign-in links. Failed refreshes disable mutations and hide the sign-in URL. No permission or API contract changed.

### Verification

- `pnpm --dir web build` passed the TypeScript check and Vite production build.
- Chromium ran intercepted synthetic responses against the built interface. Search, business filtering, hash navigation, preserved filters, heading focus, modal keyboard containment/Escape/return focus, warning acknowledgment, identity gating, and removal protection passed. The fixture made two intercepted preview requests and no customer writes.
- The existing folder-picker regression passed with the new labels: keyboard use, cancellation preserving the preview, selection clearing stale preview, exact trailing-space paths, disabled Apply during selection, focus restoration, and error retry.
- The existing sign-in regression passed: preparation state, safe anchor attributes, keyboard focus, reload, unavailable/completed/failed states, and identity checks without sign-in prompts. No Connect action or external request ran.
- Screenshots were reviewed at 1440px and 320px. The page stayed within 320px; long paths wrap and generated code scrolls inside its panel. A wrapped status label needed a height adjustment, which is included.
- Evidence: `/private/tmp/router-compact-ui-results.json`, `/private/tmp/router-compact-folder-ui-results.json`, `/private/tmp/router-compact-sign-in-ui-results.json`, and `/private/tmp/router-compact-{desktop,320-detail,320-list,320-dialog}.png`. Fixture scripts use synthetic records and intercept every network request. These checks establish frontend behavior. Native OAuth, customer writes, and server lifecycle were outside these checks.

## Glide branding (2026-10-19)

The user requested the Glide/G3 identity while retaining the compact utility layout. The header now reads “Glide / MCP router,” with the Glide mark also used as the favicon. The existing COSS/Base UI primitives receive warm neutral surfaces, aqua primary actions with black text, rounded buttons, and G3 semantic status colors. No API, authentication, project-binding, or routing behavior changed.

References were read from the tracked `glideapps/g3` checkout at commit `d2c4ec87a0b14c794986377c93ec44574b462317`:

- `packages/ui/src/colors.css`: warm neutrals, aqua, and semantic color ramps.
- `packages/ui/src/theme.css`: light theme mapping, 575 semibold, and heading tracking.
- `packages/ui/src/components/button.tsx`: aqua primary with black text and a 25% stronger-color hover mix; rounded button shape.
- `packages/ui/src/components/logo.tsx`: the 22px circle and painted inverse glyphs, adapted as the local `web/public/glide-mark.svg` asset.

The router keeps its existing density and system font. G3's BootonVF font binary and private component implementations were not copied. The Glide mark remains Glide's brand asset; this repository's MIT license does not grant rights to the mark. See [Glide's terms](https://www.glideapps.com/legal/terms). There are no remote image or font requests.

Verification: the web TypeScript check and Vite build passed. All three existing synthetic browser suites passed at desktop and 320px widths, covering search/filtering, navigation, modal focus, config warning acknowledgment, identity gating, folder selection states, and sign-in link states. The new mark loaded from the local build. Screenshots of the narrow list, detail, and dialog were inspected; no horizontal overflow or browser errors occurred. Independent source review found no defects. Black text on the aqua primary has a 14.71:1 contrast ratio. The live local dashboard was reloaded and its customer detail and Add customer dialog were inspected without saving or connecting.

Evidence: `/private/tmp/router-glide-{ui,folder-ui,sign-in-ui}-results.json` and `/private/tmp/router-glide-{desktop,320-detail,320-list,320-dialog}.png`. Synthetic tests intercept all requests and do not change customer data.
