import { chrome, element, message, readSettings } from './browser';
import { bubbleMatches, bubblePatterns, parseHostnames, patternHostname } from './bubble-hosts';
import { DEFAULT_URL, extensionSnapshotKey, normalizeUrl, permissionOrigin, SETTINGS_KEY, type ExtensionSettings } from './core';
import { ExtensionConnection, registerBridge, syncBubbleScript } from './connection';
import { FAVICON_PROVIDER_ORIGIN } from './favicon-policy';

const form = element<HTMLFormElement>('settings-form');
const address = element<HTMLInputElement>('shelf-url');
const save = element<HTMLButtonElement>('save');
const test = element<HTMLButtonElement>('test');
const status = element('status');
const open = element<HTMLAnchorElement>('open-shelf');
const cache = element('cache-status');
const clear = element<HTMLButtonElement>('clear-cache');
const hostList = element('bubble-hosts');
const allowAll = element<HTMLButtonElement>('allow-hosts');
const refreshHosts = element<HTMLButtonElement>('refresh-hosts');
const bubbleStatus = element('bubble-status');
let saved: ExtensionSettings | null = null;
let working = false;

function notify(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function busy(value: boolean) {
  working = value;
  save.disabled = value;
  test.disabled = value || !saved || address.value !== saved.url;
  clear.disabled = value || !saved;
  address.disabled = value;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-url]')) button.disabled = value;
  for (const button of hostList.querySelectorAll('button')) button.disabled = value;
  allowAll.disabled = value || !hostRows.some(row => row.missing.length);
  refreshHosts.disabled = value || !saved;
}

function changed() {
  open.hidden = true;
  test.disabled = true;
  notify('Save changes to apply this address and connection setting.');
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-url]')) {
  button.addEventListener('click', () => {
    address.value = button.dataset.url ?? DEFAULT_URL;
    changed();
    address.focus();
  });
}
address.addEventListener('input', changed);

function cacheStatus() {
  try {
    const snapshot = saved ? JSON.parse(localStorage.getItem(extensionSnapshotKey(saved.url)) ?? 'null') : null;
    cache.textContent = snapshot?.savedAt && Array.isArray(snapshot.projects)
      ? `${snapshot.projects.length} destinations saved on ${new Date(snapshot.savedAt).toLocaleString()}.`
      : 'The frontend is installed locally. Destinations will be saved after your first connection.';
  } catch { cache.textContent = 'Saved destinations could not be read. The live app can still connect.'; }
}

interface HostRow { hostname: string; patterns: string[]; missing: string[]; removable: string[]; shelfHost: boolean }
let serverHostnames: string[] = [];
let hostRows: HostRow[] = [];

function notifyBubble(text: string, error = false) {
  bubbleStatus.textContent = text;
  bubbleStatus.classList.toggle('error', error);
}

async function fetchHostnames(settings: ExtensionSettings): Promise<string[]> {
  const connection = new ExtensionConnection(settings);
  try {
    const response = await connection.request('/settings', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
    return parseHostnames(await response.json());
  } finally { connection.close(); }
}

async function refreshHostRows() {
  if (!saved) { hostRows = []; return; }
  const panel = new URL(saved.url);
  const shelfPattern = permissionOrigin(saved.url);
  const granted = bubbleMatches((await chrome.permissions.getAll()).origins ?? []).map(patternHostname);
  const names = [...new Set([panel.hostname, ...serverHostnames, ...granted])];
  hostRows = await Promise.all(names.map(async hostname => {
    const patterns = bubblePatterns(hostname, panel.protocol);
    const held = await Promise.all(patterns.map(pattern => chrome.permissions.contains({ origins: [pattern] })));
    return { hostname, patterns, missing: patterns.filter((_, index) => !held[index]),
      removable: patterns.filter((pattern, index) => held[index] && pattern !== shelfPattern), shelfHost: hostname === panel.hostname };
  }));
}

function renderHosts() {
  const focused = hostList.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.host : undefined;
  hostList.replaceChildren(...hostRows.map(row => {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'host-name';
    name.textContent = row.shelfHost ? `${row.hostname} (your Shelf host)` : row.hostname;
    const state = document.createElement('span');
    state.className = row.missing.length ? 'host-state' : 'host-state granted';
    state.textContent = !row.missing.length ? 'Allowed' : row.missing.length < row.patterns.length ? 'Partly allowed' : 'Not allowed';
    if (row.missing.length) state.title = `Still needed: ${row.missing.join(', ')}`;
    item.append(name, state);
    const action = row.missing.length ? { label: 'Allow', run: () => grant(row.missing, row.hostname) }
      : row.removable.length ? { label: 'Remove', run: () => revoke(row.removable, row.hostname) } : null;
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button';
      button.textContent = action.label;
      button.dataset.host = row.hostname;
      button.setAttribute('aria-label', `${action.label} ${row.hostname}`);
      button.disabled = working;
      button.addEventListener('click', () => { void action.run(); });
      item.append(button);
    }
    return item;
  }));
  allowAll.disabled = working || !hostRows.some(row => row.missing.length);
  refreshHosts.disabled = working || !saved;
  if (focused) hostList.querySelector<HTMLButtonElement>(`button[data-host="${CSS.escape(focused)}"]`)?.focus();
}

async function afterGrantChange() {
  await syncBubbleScript();
  await refreshHostRows();
  renderHosts();
}

async function grant(origins: string[], label: string) {
  if (working) return;
  busy(true);
  try {
    // Requested straight from the click, before any other await keeps the user gesture.
    if (!await chrome.permissions.request({ origins })) { notifyBubble('Chrome did not grant access. Nothing changed.', true); return; }
    await afterGrantChange();
    notifyBubble(`Allowed ${label}. The bubble works on every port there; reload any open dev pages.`);
  } catch (error) { notifyBubble(message(error), true); }
  finally { busy(false); }
}

async function revoke(origins: string[], label: string) {
  if (working) return;
  busy(true);
  try {
    await chrome.permissions.remove({ origins });
    await afterGrantChange();
    notifyBubble(`Removed access for ${label}.`);
  } catch (error) { notifyBubble(message(error), true); }
  finally { busy(false); }
}

allowAll.addEventListener('click', () => { void grant(hostRows.flatMap(row => row.missing), 'the remaining hostnames'); });

async function loadBubble() {
  if (!saved) { hostRows = []; renderHosts(); notifyBubble('Save your Shelf address to choose hostnames.'); return; }
  notifyBubble('Reading hostnames from your shelf…');
  try {
    serverHostnames = await fetchHostnames(saved);
    notifyBubble(serverHostnames.length ? '' : 'Your shelf has no saved hostnames. Add them in Shelf settings → Network.');
  } catch (error) {
    serverHostnames = [];
    notifyBubble(`Could not read the hostname list: ${message(error)}`, true);
  }
  await refreshHostRows();
  renderHosts();
}

refreshHosts.addEventListener('click', async () => {
  if (working) return;
  busy(true);
  try { await loadBubble(); } finally { busy(false); }
});

// Grants can also change from Chrome's own site-access controls while this page is open.
const grantsChanged = () => { void afterGrantChange().catch(() => undefined); };
chrome.permissions.onAdded.addListener(grantsChanged);
chrome.permissions.onRemoved.addListener(grantsChanged);

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (working) return;
  let settings: ExtensionSettings;
  try { settings = { url: normalizeUrl(address.value) }; }
  catch (error) { notify(message(error), true); address.focus(); return; }
  busy(true);
  notify('Saving…');
  try {
    // Request directly within the submit gesture, before any storage awaits.
    if (!await chrome.permissions.request({ origins: [permissionOrigin(settings.url)] })) {
      throw new Error('Site access was not granted. Allow access to this host so the local extension can connect to your shelf.');
    }
    await registerBridge(settings);
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    saved = settings;
    address.value = settings.url;
    open.href = chrome.runtime.getURL('newtab.html');
    open.hidden = false;
    notify('Saved. Updating site access…');
    cacheStatus();
    try {
      // Switching servers drops old host grants, but never the new server's other hostnames:
      // the user may have allowed them for the dev server bubble. Without that list, keep everything.
      const hostnames = await fetchHostnames(settings).catch(() => null);
      if (hostnames) {
        serverHostnames = hostnames;
        const protocol = new URL(settings.url).protocol;
        const keep = new Set([permissionOrigin(settings.url), FAVICON_PROVIDER_ORIGIN, ...hostnames.flatMap(host => bubblePatterns(host, protocol))]);
        const obsolete = (await chrome.permissions.getAll()).origins?.filter(origin => !keep.has(origin)) ?? [];
        if (obsolete.length) await chrome.permissions.remove({ origins: obsolete });
      }
      await afterGrantChange();
      notify(hostnames ? 'Saved. New tabs run here, without redirecting.'
        : 'Saved. New tabs run here. Earlier site access was kept because your shelf’s hostname list could not be read; review it under Dev server bubble.');
    } catch {
      notify('Saved. Old site access could not be removed; review this extension’s site access in Chrome.', true);
    }
  } catch (error) { notify(message(error), true); }
  finally { busy(false); }
});

test.addEventListener('click', async () => {
  if (!saved || working) return;
  busy(true);
  notify('Checking your shelf…');
  const connection = new ExtensionConnection(saved);
  try {
    if (!await chrome.permissions.contains({ origins: [permissionOrigin(saved.url)] })) {
      throw new Error('Site access has been removed. Save your settings again to allow the connection.');
    }
    const response = await connection.request('/health', { signal: AbortSignal.timeout(8000) });
    if (!response.ok || (await response.json()).ok !== true) throw new Error(`The server returned an unexpected health response (${response.status}).`);
    notify('Connected. Project Shelf is responding.');
  } catch (error) { notify(message(error), true); }
  finally { connection.close(); busy(false); }
});

clear.addEventListener('click', () => {
  if (!saved) return;
  try {
    localStorage.removeItem(extensionSnapshotKey(saved.url));
    cacheStatus();
    notify('Saved destinations cleared for this server. The next successful connection will save a fresh snapshot.');
  } catch { notify('The browser could not clear saved destinations.', true); }
});

async function load() {
  busy(true);
  try {
    saved = await readSettings();
    address.value = saved?.url ?? DEFAULT_URL;
    if (saved) { open.href = chrome.runtime.getURL('newtab.html'); open.hidden = false; }
    cacheStatus();
    void syncBubbleScript().catch(() => undefined);
  } catch (error) {
    address.value = DEFAULT_URL;
    notify(message(error), true);
  } finally { busy(false); }
  await loadBubble();
}
void load();
