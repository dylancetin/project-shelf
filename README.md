# Project Shelf

A compact start page for projects and self-hosted services, with a separate management view. React + Vite on the frontend, Hono running on Bun and `bun:sqlite` behind it.

## Run

```sh
bun install
bun run build
bun start
```

Open any of:

- http://beelinkk:4958
- http://192.168.1.50:4958
- http://beelinkk.tail750ac6.ts.net:4958
- http://100.119.176.63:4958
- https://panel.tail750ac6.ts.net/ (when the HTTPS reverse proxy is configured)

The randomly selected default port is **4958**. Set `PORT` to change it. Production serves the UI and API from the same Bun process. For UI development, `bun dev` runs Vite on 4958 and the backend on loopback port 4959 (override with `API_PORT`).

Hono handles routes, mutation-origin middleware, and JSON error responses in `server/app.ts`. Bun still owns the HTTP listener and shutdown lifecycle. Bounded JSON parsing and confined static/logo serving retain their existing safeguards; the API contract, database, and deployment commands are unchanged.

## Use

- **Home** (`http://beelinkk:4958/`) is a condensed launcher for everyday navigation and browser new tabs. Press `/` to search and Enter to open the first result. Project links start the configured development command, wait for the local server to respond, then navigate; an already-running development command is reused. Services open directly. Destination links open in the same tab; Ctrl/Cmd-click and middle-click open a new tab after startup. The sidebar starts closed; **Manage** (`/#manage`) opens the full project controls. Projects without an address remain accessible in Manage.
- **Home layout** defaults to compact bookmark-style columns. Switch between **Compact** and the address **Grid** using the buttons at the bottom of Home; the choice is remembered in this browser. Hover or keyboard-focus a project to reveal small, borderless ghost icons for development, build, and production beside its name in Compact (below its text in Grid) without navigating away or moving other rows. Compact names use the space of hidden controls until hover or keyboard focus reveals them; names only truncate when they exceed the available width. Hover the name for its full text. Tooltips and accessible labels identify each action. Controls stay visible on touch devices; a running managed process has an always-visible green stop control that returns to the run icon after stopping.
- **Shelf order** is shared across the website and connected extensions. Drag a destination's dedicated handle directly on Home or in Manage to save its order; Space + arrow keys and Space to drop also work. Projects and Services each stay together in one column, with separate saved item orders and no automatic “continued” groups. Manage dragging requires **Shelf order** with search/source filters cleared. Hidden/favorite/unconfigured entries omitted by a view retain their slots. **Organize** remains available for complete-list ordering with arrows, numbered positions, and explicit **Save order**/**Cancel**. Conflicting edits are rejected instead of overwritten; an older poll cannot undo a successful save.
- **Column layout** is separate from saved destination order. Arrange whole columns and move bookmark folder sections into the same column to group less-used folders without moving anything in Chrome's actual folder hierarchy. These arrangements stay local to this browser; the default layout still starts with Projects and Services. Reset returns to automatic grouping. Search does not overwrite your layout.
- **Scan directories** discovers projects under `~/.t3/projects`, `~/.t3-nightly/projects`, and `~/workspace`. Change these roots in Settings. Inside discovered projects, scans skip example/sample/demo folders and test/fixture trees (including `testdata`), while still discovering nested apps and packages. To scan an example intentionally, add its directory as an explicit root or use **Add**. Existing registrations and edits are never removed by a rescan. Missing roots are reported without blocking the others.
- **Hide from dashboard** in an entry’s details keeps it off Home and the normal Manage collections without deleting its registration or files, or stopping running commands. Use **Manage → Hidden → Show** to restore it. Visibility is saved across restarts and rescans.
- **Commands** are editable per project: development, build, and production. Production runs the build before the production command. Logs are available in project details. Stop terminates the process group started by this panel.
- Recognized Vite, Astro, and Next.js scripts get LAN binding and the configured instance port. Custom commands receive `PORT` when configured, `HOST=0.0.0.0`, and the appropriate `NODE_ENV`; their explicit shell assignments take precedence.
- **Open** in Manage and project details also starts development before visiting a project in a new tab. Missing commands, failed startup, and a 45-second readiness timeout show an error instead of navigating. Stop a running build or production command before opening development; Open never replaces it automatically. A readiness timeout does not stop the dev process. `beelinkk` is the default for direct server connections. Select a hostname on each entry to switch between LAN IP, local DNS, and Tailscale while preserving the URL's port and path. Original URL is also available.
- **Add** registers an existing project directory or service URL. **Duplicate** can create another configuration or copy the project into a new directory. Dependencies and generated files are omitted from file copies; install dependencies in the copied project before running it.
- **Logos** can be selected from image files in each project or set to an HTTP/HTTPS image URL in **Choose logo → Image URL or relative path**, then **Save changes**. Remote images load directly in your browser without a referrer; use HTTPS when the shelf is served over HTTPS. Recognized services automatically use locally bundled brand icons, matched by name or service subdomain, throughout Home and Manage. Custom project logos take precedence; unknown services and failed images fall back to a monogram. Icon sources and licenses are in [`public/service-icons/SOURCES.md`](public/service-icons/SOURCES.md). Third-party image requests are made for remote logos you configure and, in the extension, explicit online-icon refreshes you enable.
- **Services** is the source label for service shortcuts imported from a browser HTML export in Settings, distinct from the extension’s live browser bookmarks. The initial supplied export is kept locally in ignored `data/bookmarks.html` and imported on first launch. Service shortcuts open existing services; their lifecycle is managed by their existing Docker/deployment setup.
- Duplicate bookmark destinations across the four server hostnames are consolidated. Direct server links use the preferred hostname; dedicated reverse-proxy subdomains and other machines retain their original hostnames.

Project commands execute as the account running the panel. The panel is intended for your trusted local/Tailscale network. Existing processes started outside the panel are not treated as panel-managed processes.

Mutating API requests accept the request's own origin, the hostnames in **Settings → Network** using HTTP/HTTPS on the panel's port or standard HTTPS (443), and exactly **https://panel.tail750ac6.ts.net**. Network hostname edits take effect immediately; only add hosts you trust to control the panel. Imported service URLs and per-entry hostname overrides do not automatically become trusted API origins, nor do other service ports. Unknown/null/extension origins and cross-origin requests without an allowed Origin remain blocked. Forwarded headers do not grant access, and this does not enable cross-origin browser API access (CORS).

## Data and checks

Local state lives in `data/panel.sqlite`; `data/` is excluded from Git. Back up this directory to preserve project settings and imported shortcuts.

See [`AGENTS.md`](AGENTS.md) for the code map, development conventions, and fixture-based verification workflow.

```sh
bun run typecheck
bun test
bun run build
```

With the app running, `bun run smoke` checks the API using temporary fixture projects, including development/build/production commands, stopping, logos, and duplication.

## Keep it running with systemd

`deploy/project-shelf.service` is a user service for this checkout. **Every start and restart runs `bun run build` before serving on port 4958.** A failed build prevents startup and is retried after 10 seconds; it never silently serves an old build. The server also restarts after unexpected clean exits or crashes. An explicit `systemctl stop` stays stopped. Update its paths if moving the checkout or Bun executable. Install dependencies with `bun install --frozen-lockfile` after dependency changes (not on every boot).

```sh
systemctl --user link "$PWD/deploy/project-shelf.service"
systemctl --user daemon-reload
systemctl --user enable --now project-shelf
sudo loginctl enable-linger "$USER"
journalctl --user -u project-shelf -f
```

Linger keeps the user service running after logout and starts it at boot without an interactive login; it is already enabled on this machine. If updating an already-running installation, run `systemctl --user daemon-reload` then `systemctl --user restart project-shelf`.

After changing code: **`systemctl --user restart project-shelf`**. The restart rebuilds automatically. Restarting the panel stops project processes it manages; it does not start those projects again automatically. The app is briefly unavailable during the build. Inspect status with `systemctl --user status project-shelf` and build/startup errors with `journalctl --user -u project-shelf -n 80 --no-pager`.

## Search shortcuts

Home search sits in the header to leave more room for destinations and stays local by default. Use `!g query` (Google), `!gh query`
(GitHub), `!yt query` (YouTube), `!w query` (Wikipedia), or any of the 13,570
shortcuts imported from [Unduck](https://github.com/t3-content/unduck). A bang can
appear before or after the query; a bare `!gh` opens GitHub's homepage. Enter or
click the preview to open the destination in the same tab; Ctrl/Cmd-click and
middle-click on the preview use native new-tab behavior. Unknown bangs visibly
fall back to your default search engine (DuckDuckGo initially). Ordinary
Enter-to-open shelf search is unchanged.
The catalog is a separate fingerprinted, precached asset, loaded/parsed only when
bang search is used. Bang resolution works offline; the destination site still
needs a connection. See `THIRD_PARTY_NOTICES.md` for source and license details.

### Use Shelf as your browser search engine

No extension is required. In Brave/Chrome, open **Settings → Search engine →
Manage search engines and site search → Add**, then enter:

- **Name:** Project Shelf
- **Shortcut:** `shelf`
- **URL with %s in place of query:** `http://beelinkk:4958/search?q=%s`

Use the entry's menu to **Make default**, or type `shelf` then Tab/Space in the
address bar to use it only when needed. Browsers supporting OpenSearch can also
discover Shelf's search engine from its homepage (`/opensearch.xml`).

Address-bar searches such as `!gh bun`, `bun !yt`, or a bare `!w` redirect
straight to the matching website using the same local catalog as Home. Plain
queries and unknown bangs use your default engine. Choose **Settings → Search →
Default search engine**: **DuckDuckGo** (the default), Google, Bing, or Brave Search.
The choice is saved on the Shelf server, applies immediately to browser searches
and Home's unknown-bang fallback, and is retained in offline snapshots. Explicit
bangs such as `!g` and `!ddg` always keep their own engine. Settings also shows the
browser search URL for your current Shelf address.

Empty queries return Home. This endpoint
never launches projects or searches your local registrations; Home search is
unchanged. Redirects are not cached, and no search history is stored by Shelf.

You can replace the origin with any reachable Shelf address, including
`http://192.168.1.50:4958` or `https://beelinkk.tail750ac6.ts.net` when HTTPS Serve
is configured. The Shelf server must be reachable for address-bar searches;
the new-tab extension's offline catalog does not intercept them.

## Chrome new-tab extension

The Brave/Chrome companion runs the same React frontend **inside the extension**,
not a redirect or a remote-app frame. Its UI, bundled icons, and bang catalog are
installed locally. New tabs show the last saved destinations immediately and
refresh live data in the background. Nothing autofocuses the page search, so the
browser retains its normal new-tab address-bar focus.

Run `bun run extension:build` on the server. Extension updates use **SCP, not
Nextcloud**. Every extension-update handoff should include this command to run
on the computer running the browser (SSH access to `taytay@beelinkk` is required):

```sh
mkdir -p "$HOME/Documents/ProjectShelf"
scp -r taytay@beelinkk:/home/taytay/.t3-nightly/projects/dev-server-panel/extension/dist/. "$HOME/Documents/ProjectShelf/"
```

This copies the built extension's contents into the same permanent folder on
every update, with `manifest.json` directly inside `~/Documents/ProjectShelf`.
Use a reachable server alias such as `beelinkk.tail750ac6.ts.net` if needed.

For the first install, open `brave://extensions` (or `chrome://extensions`), enable
**Developer mode**, and **Load unpacked** → `~/Documents/ProjectShelf`. Disable
your previous new-tab redirect extension. Open a new tab to set your Shelf address
(default **http://beelinkk:4958/**), allow access to that host, and save.

For later updates, rerun the SCP commands above, click **Reload ⟳** on the existing
extension card, and open a fresh tab. **Do not remove/reinstall the extension or
change its folder**; reloading in place preserves extension-local settings, saved
layout, and caches. Unpacked extensions do not automatically download updates.
When updating from the old redirect companion, also save its settings once.

The updated panel must also be running: its inert `/api/extension/bridge` page
lets an isolated, host-authorized content script keep API requests same-origin.
No server CORS or extension-origin mutation exceptions are added. Live process state and
commands are never cached or queued. Each server’s metadata snapshot stays
separate in extension-local storage. No browsing-history access is requested.
**Show browser bookmarks** optionally requests Chrome's bookmarks permission.
Bookmarks stay in that browser profile, are searchable alongside shelf destinations,
and are never uploaded to the web service. Browse folders and use **Organize** inside
a folder to save its order directly to Chrome (including the bookmarks bar).
Root/managed browser folders cannot be reordered. HTTP(S) bookmarks open as normal
links; executable bookmarklets and other schemes remain visible but are not opened
by Shelf. Native bookmark events refresh open new tabs automatically.
Bookmarks share compact columns with Projects and Services first by default. Whole
folder trees stack within columns and expand inline; open branches are remembered
across new tabs. **Arrange shelf** lets you group folder sections into the same
column and reorder columns without changing Chrome's hierarchy. Row handles save
sibling bookmark order directly to Chrome. Names and tiny icons occupy one line;
hover shows addresses. Saved/Chrome icons, bundled brands and colored initials
work locally. **Enable online icons** / **Refresh online icons** explicitly sends
public hostnames only to DuckDuckGo's favicon service and caches the results;
private/local/Tailscale names are excluded, and new tabs make no provider requests.
**Clear saved icons** removes that local cache. Bookmark websites are not contacted
for acquisition, and full bookmark URLs are never sent to the icon provider.
The normal website’s separate PWA cache is unchanged. See
[`extension/README.md`](extension/README.md) for updates, permissions, and limits.

## Installable app and offline access

PWA installation and offline reloads require **HTTPS** (or `http://localhost:4958` on the server itself). Plain `http://beelinkk:4958` and LAN/Tailscale IP URLs remain usable online but browsers do not enable service workers on those origins.

For persistent, tailnet-only HTTPS with Tailscale Serve:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:4958
```

Then open **https://beelinkk.tail750ac6.ts.net/** while connected to Tailscale. This adds a node-level endpoint; existing named service proxies remain unchanged. Serve's background configuration persists across reboots. Do not use Funnel: this panel can execute commands and must stay on a trusted network. To undo only this endpoint: `sudo tailscale serve --https=443 off` (do not reset all Serve configuration).

- Visit once online and check **Settings → Offline app** for “App saved for offline use.” Install using its install button where supported, the browser's Install app menu, or Safari's **Share → Add to Home Screen** on iPhone/iPad.
- The app shell, styles, scripts, app icons, and bundled service icons are precached. The last successfully fetched project/service registrations and settings are saved in this browser. Search, grouping, details, and service links remain available after an offline reload. Linked destinations still need their own network access; this does not cache other apps.
- With an active service worker, repeat visits show the cached shell and saved destinations immediately while fresh app/data versions download in the background. Saved metadata uses stale-while-revalidate; the shell uses a versioned cache-first precache, as in Unduck. The initial server check does not show a loading screen or an offline warning when a saved shelf exists; runtime stays unknown and server actions stay paused until a live response arrives. HTML also allows a one-day stale-while-revalidate window in the browser HTTP cache, and fingerprinted bundles are cached immutably for one year. Browsers may still validate top-level navigations without a service worker; plain HTTP does **not** guarantee fast or offline reloads. Use HTTPS for the full cached startup path.
- An unavailable server shows a saved-data timestamp. Runtime becomes **Status unknown**, not an old “Running” or “Stopped” indicator. Launch/start/stop, editing, imports, scanning, duplication, and live logs require the server. Mutations are never cached, queued, or replayed. Project links still require server startup/readiness; service links remain native links.
- The shelf reconnects automatically on a three-second visible-page poll and on returning online/to the tab. Unsaved form drafts are preserved. Successful changes refresh the saved snapshot, including hiding or deleting entries.
- A new production build prompts **Reload to update**; it does not forcibly reload an open form. The previous installed app stays available until the new version is fully downloaded. PWA caching is disabled during `bun dev`.
- Saved data is origin-specific: HTTP, HTTPS, different hostnames, and ports have separate storage. It contains project metadata and configured commands, not logs or live process state. Use a trusted browser/device; clearing site data or browser storage eviction removes offline access. Custom remote/project logos may fall back to monograms offline. When browser storage is blocked/full, the live app still works but cannot refresh its offline snapshot.

## Agent preview servers

Agents can start manually retained previews using the authenticated [Agent Servers MCP](docs/agent-servers.md). Runs appear beneath Projects on Home and in the extension, with Visit, Logs, and Stop. They survive panel restarts through independent user-systemd units; existing registered projects retain their normal lifecycle. The same MCP provides `projects_list`, `project_run` (`dev`, `build`, or `prod`), and `project_logs` for registered projects. The repository-local required-workflow skill is installed at `/home/taytay/.agents/skills/project-shelf-agent-servers`.
