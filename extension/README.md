# Project Shelf · Native new-tab companion

The existing React frontend runs directly inside this Brave/Chrome extension.
Opening a new tab never navigates to `beelinkk`, and startup never focuses an
input. The browser keeps its normal new-tab omnibox focus; clicking a destination
still navigates normally, and `/` focuses Shelf search after the page has focus.

## Install or update

1. Build the updated panel with `bun run build` and restart `project-shelf` per
   the main README. The small `/api/extension/bridge` endpoint is required.
2. Run `bun run extension:build`.
3. Copy the built extension from the server to a permanent folder under
   `~/Documents` on the computer running the browser. Delivery uses **SCP, not
   Nextcloud**; every extension update should include these commands:

   ```sh
   mkdir -p "$HOME/Documents/ProjectShelf"
   scp -r taytay@beelinkk:/home/taytay/.t3-nightly/projects/dev-server-panel/extension/dist/. "$HOME/Documents/ProjectShelf/"
   ```

   SSH access to `taytay@beelinkk` is required. Substitute a reachable server alias
   such as `beelinkk.tail750ac6.ts.net` if needed. The `dist/.` source copies the
   contents, keeping `manifest.json` directly inside `~/Documents/ProjectShelf`
   rather than creating a nested `dist` folder on subsequent updates.
4. For the first install, open `brave://extensions` or `chrome://extensions`, enable
   **Developer mode**, disable the previous redirect extension, and **Load unpacked**
   → `~/Documents/ProjectShelf`.
5. Open a new tab, click **Set up Project Shelf**, save your reachable server
   address, and allow access to that host. Pin the toolbar icon for Home/Manage.
6. For later updates, rerun the SCP commands after the new build, click **Reload ⟳**
   on the existing extension card, and open a fresh tab. Keep the same folder;
   **do not remove/reinstall the extension**. Reloading in place preserves settings,
   saved layout, and caches. Unpacked extensions do not automatically download
   updates.

Updating v1.0 retains your configured address, but removes the old redirect and
connection-check mode. Open extension options and **Save settings** once to grant
host access and register the isolated API connection. Existing website/PWA data
stays untouched; the new extension snapshot is populated on its first connection.

Default: **http://beelinkk:4958/**. Local DNS, LAN IP, Tailscale IP, and Tailscale
HTTPS suggestions are provided. HTTPS requires Tailscale Serve as documented in
the main README. Native extension caching also works with the HTTP LAN address.

## Cache and focus behavior

- JavaScript, CSS, the bang catalog, and service icons are installed local files.
  No redirect, remote module download, health-gated splash, or PWA install is needed.
- Each configured server has a separate saved registration/settings snapshot.
  Subsequent tabs render it first, then fetch fresh data. Ordinary polling,
  returning online, and tab visibility restore live state without replacing forms.
- Cached runtime is always **unknown** until the server responds. Server commands,
  edits, and logs require a live connection and are never cached, queued, or replayed.
- Search, bang resolution, grouping, details, and service links work after an
  offline hard reload. Linked websites and project startup still need connectivity.
- Extension options show the saved snapshot time/count and can clear that server’s
  saved destinations. Clearing it does not change server registrations or files.
- No startup `.focus()`, `autofocus`, top-level navigation, or omnibox manipulation.
  Clicking Shelf search or another control naturally moves focus into the page;
  the extension does not fight that deliberate action. It cannot override custom
  browser settings or another extension’s focus behavior.
- This intentionally uses locally bundled shared source, not runtime Module
  Federation. UI updates require rebuilding/reloading the extension; data and
  server changes arrive live. It remains Manifest V3 compatible in Brave/Chrome.

## Secure server connection

The extension requests **storage**, **scripting**, **activeTab**, and optional access
to the exact configured scheme/hostname (Chrome host grants include every port on
that host). **activeTab** only lets the toolbar popup read the address of the tab it
was opened on. It does not request the `tabs` permission, browsing history, or
arbitrary-site access. **Bookmarks**
is a separate optional permission, requested only after clicking **Show browser
bookmarks** on Home. Denying it does not affect projects or services.

On connection it registers a packaged isolated content script **only for the
`/api/extension/bridge` path**, then loads that tiny inert document in a hidden,
non-focusable frame. The Shelf UI itself is not framed. The script accepts only
bounded API requests from this extension’s exact parent origin/window, and runs
normal same-origin JSON fetches in the server document. Replies are checked
against the exact server origin and frame. Abort signals propagate; there is no
automatic retry or replay of failed mutations.

The document contains no remote JavaScript or message handler of its own, and
cannot be framed by an ordinary website. Neither other websites nor other
extensions can use our script as a command proxy. The server still rejects direct
cross-origin/extension-origin mutations; no CORS exception or public command API
is added. Revoked host permission pauses requests. Changing servers releases old
host grants. No background process is kept alive.

Snapshots include project metadata/configured commands, not logs or live process
state. They stay in this browser’s extension storage, not Chrome Sync or an
external service. Configured remote logos and explicit online-icon refreshes can make third-party requests;
unavailable logos fall back to monograms. Uninstalling clears extension data.

## Dev server bubble

A small floating bubble in the bottom-right corner of pages served by your dev
servers (`http://beelinkk:5173/…`), opening controls and logs for that server. The
same controls appear in the toolbar popup for the active tab. The UI is the panel's
own `/embed.html`; the extension only hosts it. The framed page is panel-origin, so
it makes its own same-origin API calls: the extension proxies nothing, adds no
background worker, and the server gains no CORS or origin exceptions.

- **What runs where.** A content script (about 6 KB, plain TypeScript) is registered
  for every granted host, top frame only, at `document_idle`. It frames
  `/embed.html?surface=bubble&url=<page origin>` in a **closed shadow root** on one
  fixed host element, at the top of the z-index range, and stays invisible until the
  embed posts a `layout`. The embed alone decides whether the page is a dev server.
  Only the page **origin** is sent, never its path, query, or fragment, and the frame
  is loaded without a referrer. The panel only lets the page at that origin frame it
  (`frame-ancestors 'self' <origin>` for this request), and the embed double-checks its
  direct parent, so another dev server on the same machine cannot frame the controls for
  a different one. The popup's frame is allowed for extension pages only.
- **Trust.** Messages count only from that iframe's window, from the panel origin,
  and with the `shared/embed.ts` shape. A message posted by the page itself, or by
  another frame at the panel origin, is ignored. The script does nothing on the panel's
  own origin, and on `https` pages when the panel is `http` (the browser would block
  that frame as mixed content).
- **Settings** live in `chrome.storage.local` under `project-shelf.bubble`, are
  validated by `parseBubbleSettings`, and are shared by the bubble and the popup. A
  change from either (or from another tab) is applied and re-posted to every frame
  without a reload. **Hide on this site** adds the origin to `hiddenOrigins`; the
  toolbar popup then shows **Show bubble on this site**, and the bubble returns in
  open tabs immediately.
- **Host access.** Chrome's host grant is per scheme and hostname and ignores the
  port, so the grant for your Shelf host (`http://beelinkk/*`) already covers
  `http://beelinkk:5173`, `:3000`, and every other port with no extra prompt. This
  was confirmed in Chromium: a page on a second port of the granted host gets the
  bubble, `chrome.permissions.contains` is true for any port of that host, and a
  different hostname (`localhost`) gets nothing. **Other hostnames** (LAN IP,
  Tailscale) need their own grant: **Extension settings → Dev server bubble** lists
  the panel's hostnames from `GET /api/settings`, shows which are allowed, and each
  **Allow** / **Allow remaining hostnames** / **Remove** is a click that Chrome
  confirms. If your Shelf address is `https` (Tailscale HTTPS), Chrome treats
  `http://host/*` as a separate grant, so that host reads **Partly allowed** until
  you also allow its plain-HTTP dev pages. Saving a new Shelf address now keeps every
  hostname of the new server; it only drops grants that server does not list.
- **Registration.** `syncBubbleScript` registers the content script for exactly the
  granted exact-host patterns (never "all sites" or wildcard grants) and is re-run
  from the options page, the popup, and every new tab. After **Reload ⟳** (or an
  update) Chrome drops dynamically registered content scripts, bridge included, so
  the bubble returns the first time you open a fresh tab, the popup, or the options
  page; open a new tab once after reloading.
- **Pages with a strict CSP.** Styles are applied through the CSSOM, never an injected
  `<style>`, so a `style-src` policy does not break it. A page whose `frame-src` blocks
  the panel simply never shows a bubble; nothing is logged or thrown.
- **Appearance.** The frame is transparent (`color-scheme: light`, matching the embed,
  which must not request a dark scheme or the browser paints an opaque backdrop). The
  idle bubble uses `idleOpacity`; the panel is always opaque and is clamped to the
  window with an 8 px margin, so it stays on screen in small windows.

## Browser bookmarks and ordering

The Bookmarks section reads this Chrome/Brave profile's actual bookmark tree,
including nested folders. Search matches titles, URLs, and folder paths; Enter
opens the first shelf result, or the first safe bookmark when there are no shelf
matches. HTTP(S) links retain same-tab, middle-click, and Ctrl/Cmd-click behavior.
Bookmarklets and other URL schemes are shown but cannot execute in Shelf.
The default layout starts with one Projects column and one Services column, never
automatically split into “continued” groups. Bookmark folders follow alongside
them in the same responsive layout, wrapping into another row when needed. Loose
links stay under their browser root; first-level folders become compact sections,
with several whole folder trees stacked in each column. Every root is included.
Nested folders expand inline; several branches can stay open simultaneously.
Top-level sections start open; expansion/collapse is remembered across new tabs
and synchronized between open Shelf tabs. Expanding a folder never redistributes
other folders between columns. Rows show only a tiny icon and name (24px on
desktop); hover reveals the full name, address, and folder path. Search still finds
bookmarks inside collapsed branches without changing their saved open state.

**Arrange shelf** enables dedicated handles for whole columns and folder sections.
Drag less-used folders into the same bookmark column, drop into an empty column,
or use **Add column** / the new-column drop area. Columns themselves can be reordered,
including Projects and Services. Column/position controls provide a non-drag
alternative. **Done arranging** returns to the compact view; **Reset layout**
restores automatic grouping. Arrangements persist in this browser and synchronize
between Shelf tabs. Search and temporary bookmark-access failures do not erase
them. These moves only change Shelf presentation, never Chrome's folder hierarchy.

Outside Arrange mode, small row handles reorder bookmarks directly within their
current Chrome folder. Native folders can be reordered among their siblings, not
moved to a different native parent. Root loose links preserve omitted folder slots.
Drag-start snapshots reject conflicting native edits, and Escape cancels without
writing. Mouse, long-press touch, and Space/arrow-key dragging are supported.

The reorder icon beside a folder or **Organize bookmarks…** below the columns
stages that folder's complete sibling list, including folders.
Drag the handle, press Space then arrow keys, use up/down buttons, or choose a
position. Save writes `chrome.bookmarks.move` calls to that profile; Cancel writes
nothing. Chrome's permanent root folders and managed folders cannot be reordered.
Open tabs refresh after bookmark creation, editing, deletion, moving, or import.
These bookmarks are not sent to the panel, cached in the server snapshot, or
converted into services. Chrome itself controls any browser-account sync.

Chrome moves are not transactional: a permission failure or concurrent edit can
leave some moves applied. Shelf stops, refreshes the actual tree, and asks you to
close/reopen Organize before retrying. It never rolls back another tab's edits.

Projects and services can be dragged directly in Home and Manage; the dedicated
organizer remains available. These independent item orders save on the web service,
not in the browser-local column layout. Connected extensions receive them through their
normal refresh and offline snapshot. Update both the server and extension to use
this feature; reload the extension and click **Show browser bookmarks** once.

### Reliable site icons

Bookmarks use saved icons, Chrome's local database when permitted, bundled known
brand/service logos, or distinct colored site initials—not an identical globe for
every missing icon. Generic Chrome placeholders are detected instead of reported
as branded icons. Existing saved caches are retained; saved blobs do not require a
current network grant to render.

Click **Enable online icons** to request the exact optional host grant
`https://icons.duckduckgo.com/*` and optional Chrome `favicon` access. Only this
explicit action or **Refresh online icons** fetches from DuckDuckGo's favicon
service. It receives public website **hostnames only**, never bookmark paths,
queries, fragments, credentials, or the complete bookmark tree. No bookmarked
website host permissions are requested. IP literals, short names, private/special
DNS suffixes (including all Tailscale `*.ts.net` names), and nonstandard ports are
excluded from online lookup. Local/private bookmarks retain offline fallbacks.
Saving or switching the Shelf server preserves the separate favicon-provider grant.

Opening a new tab never contacts the icon provider. Successful downloads are
validated, decoded, normalized into PNG, and saved in extension-local IndexedDB;
SVG/HTML, invalid/oversized images, and redirects are rejected. The cache is bounded
to 1,000 entries and 128 KiB per icon. Chrome entries are page-specific; online
entries are shared by public hostname. Offline or failed refreshes retain usable
saved icons, and persistence failures report that icons are available only in this
tab. **Clear saved icons** removes cached images without changing bookmarks or
silently downloading them again. Uninstalling removes the cache. Declining icon
access does not affect bookmarks, ordering, or the web service.
