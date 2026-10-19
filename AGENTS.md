# Project Shelf — agent guide

## Purpose

Project Shelf is a compact personal start page for navigating local projects and self-hosted services, suitable as a browser new-tab page. Home prioritizes search and one-click destinations; Manage contains the full project controls. The sidebar is closed by default at every screen size. It discovers project directories, runs development/build/production commands, manages the process trees it starts, and opens instances using selectable server hostnames. Services imported from bookmarks are links, not Docker-managed workloads.

Build on the existing application rather than replacing it with a demo. Display real API state; never seed fictional projects, availability indicators, or usage statistics.

## Stack and commands

- **Runtime/package manager:** Bun. Use `bun install`; commit `bun.lock` when dependencies change.
- **Backend:** Hono on Bun HTTP server, TypeScript, built-in `bun:sqlite`.
- **Frontend:** React, Vite, plain CSS, `@phosphor-icons/react`.
- **Default application port:** `4958`. Keep this stable unless the task explicitly changes it.

```sh
bun dev                 # Vite :4958; backend on loopback :4959
bun run typecheck       # TypeScript across client, server, scripts, and tests
bun test                # Isolated fixture-based backend tests
bun run build           # Typecheck and production Vite build
bun start               # Bun serves dist/ and /api on :4958
bun run smoke           # Black-box checks against http://127.0.0.1:4958
```

The smoke script accepts a different base URL: `bun scripts/smoke.ts http://127.0.0.1:4960`.

`PORT` changes the public port. In development, `API_PORT` changes the backend proxy target. `HOST` controls the production bind address; it defaults to `0.0.0.0`. `PANEL_DB_PATH` selects a different database for isolated instances.

## Code map

| Path | Responsibility |
| --- | --- |
| `shared/types.ts` | Shared project, runtime, settings, logo, and log contracts |
| `shared/bangs.ts`, `shared/search.ts`, `server/search.ts` | Shared bang resolution, selectable default search providers (DuckDuckGo initially), and browser search redirects/OpenSearch discovery |
| `server/index.ts` | Server entry point, startup, signal handling |
| `server/app.ts` | Hono routes/middleware, bootstrap, request coordination, confined static serving |
| `server/store.ts` | SQLite storage and settings defaults |
| `server/processes.ts` | Process groups, lifecycle state, log buffers, shutdown |
| `server/launch.ts` | Local HTTP readiness checks before project navigation |
| `server/scanner.ts` | Recursive discovery and command/port inference |
| `server/paths.ts`, `server/logos.ts` | Filesystem boundaries, copying, image discovery/serving |
| `server/bookmarks.ts`, `server/validation.ts` | Bookmark parsing and request validation |
| `src/api.ts` | Browser API client, instance URL construction, shared UI helpers |
| `src/App.tsx` | Dashboard, navigation, filtering, project cards, runtime polling |
| `src/Launcher.tsx`, `src/launcher.css` | Compact Home destinations, grouping, keyboard search, new-tab layout |
| `src/*Dialog.tsx`, `src/DetailsSheet.tsx` | Add/settings flows and project management |
| `src/components.tsx`, `src/styles.css` | Reusable UI primitives and visual system |
| `tests/` | Bun tests using disposable directories and processes |
| `scripts/smoke.ts` | End-to-end API checks with cleanup |
| `deploy/project-shelf.service` | User systemd service for this checkout |

`IMPLEMENTATION.md` describes the original API contract; `shared/types.ts` and the implementation are authoritative. Update relevant documentation when behavior changes.

## Local environment and data

The configured discovery roots initially are:

- `/home/taytay/.t3/projects` — may not exist; handle this as a scan result, not a fatal error.
- `/home/taytay/.t3-nightly/projects`
- `/home/taytay/workspace`

Server hostnames are `beelinkk` (the default), `192.168.1.50`, `beelinkk.tail750ac6.ts.net`, and `100.119.176.63`. Settings and per-entry overrides are editable. Direct-server entries use the preferred hostname; dedicated reverse-proxy subdomains and other machines preserve their original hostnames. Frontend API requests must remain same-origin and work through all four addresses.

Runtime state lives in ignored `data/panel.sqlite`; the initial bookmark export is ignored `data/bookmarks.html`. Do not commit databases, bookmark exports, logs, secrets, or generated `dist/` assets. Preserve existing user registrations and edits across migrations. Never reset the live database to fix a development issue; use an isolated database instead.

The checked-in systemd unit uses absolute paths for this machine, including Bun, Node, and pnpm. Keep these paths and the README consistent when changing deployment. After a production update, restart `project-shelf`; its `ExecStartPre` builds before every start/restart and blocks startup on build failure. Restarting the panel also stops its managed project processes.

## Backend invariants

- Keep the API shapes aligned with `shared/types.ts`. Return actionable JSON errors with appropriate HTTP status codes.
- Validate incoming fields and retain the same-origin checks for mutations. Use parameterized SQLite queries.
- Discovery reads manifests/configuration; it must **not execute project code**, install dependencies, or start workloads. Skip dependency, cache, generated, Git, and symlink directories. Repeat scans must not overwrite user-edited entries.
- Start commands only on an explicit start request. Development, build-only, and build-then-production are distinct operations. A failed build must prevent the production command from running.
- Each managed command has an isolated process group. Stop, deletion, and server shutdown must clean up descendants, with bounded graceful termination and escalation. Do not kill processes merely because they occupy a port.
- Do not leak the panel's own `PORT`, `API_PORT`, or database configuration into managed projects. Honor each project's configured port and run mode. Explicit command-level environment assignments must still work.
- Bound retained log output and preserve stdout/stderr distinction. Runtime status must reflect actual managed process state, not URL reachability.
- Registration deletion removes a database entry, **never project files**. File duplication must not overwrite an existing destination; omit dependencies, Git history, and generated/cache folders.
- Enforce filesystem containment and symlink boundaries for logos and static files. A supplied image path must not expose arbitrary host files.
- Hostname switching changes the hostname only, preserving URL protocol, port, path, query, and fragment. Store original imported URLs intact. Apply the preferred hostname to recognized direct-server aliases only; preserve Tailscale subdomains used by reverse proxies.

## Frontend conventions

Keep the warm, quiet workspace aesthetic: off-white surfaces, charcoal text, fine borders, restrained pastel monograms, serif page headings, and compact sans-serif controls. Home should remain a fast, condensed navigation surface, not a management-card grid or a marketing page. Use existing CSS variables and component patterns. Avoid gradients, prominent shadows, decorative marketing sections, and new UI frameworks.

Root/empty hash is Home; `#manage` and `#manage/running`, `#manage/favorites`, `#manage/services` are management routes. Preserve browser back/forward behavior. Home uses same-tab destination links, `/` to focus search, and Enter to open the first result. Project navigation starts or reuses development, waits for local HTTP readiness, then opens the preferred URL; services remain native direct links. Ctrl/Cmd-click and middle-click preserve new-tab project opening. Manage/details Open uses the same launch flow in a new tab. Projects without a configured URL stay in Manage. The navigation drawer must be unmounted when closed and trap/restore focus when opened/dismissed.

Use the existing API client rather than scattering fetch calls. Keep operation-specific busy states, recoverable errors, and meaningful empty states. Polling must clean up on unmount and must not overwrite unsaved form drafts. Buttons and links must perform their named action; do not add placeholder controls.

Preserve keyboard access, dialog focus management/Escape behavior, visible focus indicators, accessible names, and reduced-motion support. Check the dashboard and sheets at desktop and approximately 390px mobile widths. No horizontal page overflow.

## Extension delivery

Whenever the browser extension is updated—including changes to shared frontend code bundled into it—build it with `bun run extension:build`. Do not upload extension builds to Nextcloud or require a ZIP/share link. Deliver the complete built `extension/dist/` contents via SCP; do not include source files, dependencies, databases, logs, or secrets.

Every extension-update handoff must include the exact SCP commands for the user to run on the computer running their browser, targeting the same permanent folder under `~/Documents`:

```sh
mkdir -p "$HOME/Documents/ProjectShelf"
scp -r taytay@beelinkk:/home/taytay/.t3-nightly/projects/dev-server-panel/extension/dist/. "$HOME/Documents/ProjectShelf/"
```

Use the actual built source path if the checkout moves. SSH access to `taytay@beelinkk` is required; a reachable server alias such as `beelinkk.tail750ac6.ts.net` may be substituted. The source's `/.` copies contents into the existing destination rather than nesting another `dist` folder. Keep `manifest.json` directly inside `~/Documents/ProjectShelf`.

Tell the user to **Load unpacked** from `~/Documents/ProjectShelf` only for the first install. For subsequent updates, rerun the same SCP commands, click **Reload ⟳** on the existing extension card in `chrome://extensions` or `brave://extensions`, and open a fresh tab. Do not tell them to remove/reinstall the extension or change its folder; reloading in place preserves extension-local settings, saved layout, and caches. A local build path alone is not sufficient delivery. If the build fails, report the concrete blocker; do not claim a successful build or transfer that was not verified.

## Verification

For backend behavior changes, run the relevant fixture tests and `bun run typecheck`. For integrated changes, also build and run the smoke checks against an isolated or local instance. Extend tests for consequential failures such as orphaned processes, failed builds, traversal, copy collisions, or lost persistence; avoid tests that merely mirror markup or trivial implementation details.

Tests must use temporary fixtures under `/tmp/opencode`, isolated databases, and disposable commands. Do not start, build, stop, copy, or delete real user projects as test fixtures. Always clean up test registrations and child processes.

For visible UI changes, open the running application in a real browser, check the affected interaction, inspect desktop/mobile rendering, and capture the final result. Follow any applicable screenshot-sharing skill. A successful TypeScript build alone does not verify UI behavior.

Before handing work back, report the application URL, checks actually run, and any remaining concrete blocker. Do not claim an app or test passed based only on code inspection.

## Parallel work

When delegation is requested, agree on `shared/types.ts` and route shapes first, then assign non-overlapping files. A useful split is backend (`server/`, backend tests), frontend (`src/`), and integration/configuration. Do not launch competing implementations or let agents overwrite one another's work. Respect the user's requested model and reasoning level when available.
