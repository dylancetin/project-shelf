import { chrome, element, message, readSettings } from './browser';
import { DEFAULT_URL, extensionSnapshotKey, normalizeUrl, permissionOrigin, SETTINGS_KEY, type ExtensionSettings } from './core';
import { ExtensionConnection, registerBridge } from './connection';
import { FAVICON_PROVIDER_ORIGIN } from './favicon-policy';

const form = element<HTMLFormElement>('settings-form');
const address = element<HTMLInputElement>('shelf-url');
const save = element<HTMLButtonElement>('save');
const test = element<HTMLButtonElement>('test');
const status = element('status');
const open = element<HTMLAnchorElement>('open-shelf');
const cache = element('cache-status');
const clear = element<HTMLButtonElement>('clear-cache');
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
    // Drop obsolete host grants after switching servers.
    try {
      const keep = permissionOrigin(settings.url);
      const obsolete = (await chrome.permissions.getAll()).origins?.filter(origin => origin !== keep && origin !== FAVICON_PROVIDER_ORIGIN) ?? [];
      if (obsolete.length) await chrome.permissions.remove({ origins: obsolete });
      notify('Saved. New tabs run here, without redirecting.');
      cacheStatus();
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
  } catch (error) {
    address.value = DEFAULT_URL;
    notify(message(error), true);
  } finally { busy(false); }
}
void load();
