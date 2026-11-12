import { DEFAULT_BUBBLE_SETTINGS, embedUrl, type BubbleSettings, type HostToEmbedMessage } from '../../shared/embed';
import { chrome, element, hasAccess, message, readBubbleSettings, readSettings, writeBubbleSettings } from './browser';
import { pageOrigin } from './bubble-hosts';
import { appBaseUrl, checkConnection } from './core';
import { syncBubbleScript } from './connection';
import { acceptEmbedMessage, withoutHiddenOrigin } from './embed-host';

const status = element('connection-status');
const address = element('address');
const links = element('destinations');
const home = element<HTMLAnchorElement>('home');
const manage = element<HTMLAnchorElement>('manage');
const embed = element('embed');
const showBubble = element<HTMLButtonElement>('show-bubble');

element<HTMLButtonElement>('settings').addEventListener('click', async () => {
  try { await chrome.runtime.openOptionsPage(); window.close(); }
  catch (error) { status.textContent = message(error); }
});

let bubble: BubbleSettings = DEFAULT_BUBBLE_SETTINGS;
let siteOrigin = '';
let frame: HTMLIFrameElement | null = null;
let panelOrigin = '';
let ready = false;

function refreshShowBubble() {
  showBubble.hidden = !siteOrigin || !bubble.hiddenOrigins.includes(siteOrigin);
}

function post() {
  if (!ready || !frame?.contentWindow) return;
  const settings: HostToEmbedMessage = { source: 'project-shelf-host', type: 'settings', settings: bubble };
  frame.contentWindow.postMessage(settings, panelOrigin);
}

async function store(next: BubbleSettings) {
  await writeBubbleSettings(next);
  bubble = next;
  refreshShowBubble();
  post();
}

showBubble.addEventListener('click', async () => {
  showBubble.disabled = true;
  try { await store(withoutHiddenOrigin(await readBubbleSettings(), siteOrigin)); }
  catch (error) { status.textContent = message(error); }
  finally { showBubble.disabled = false; }
});

async function mountEmbed(base: string) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  siteOrigin = pageOrigin(tab?.url);
  bubble = await readBubbleSettings();
  refreshShowBubble();
  panelOrigin = new URL(base).origin;
  frame = document.createElement('iframe');
  frame.title = 'Project Shelf controls';
  frame.setAttribute('allow', 'clipboard-write');
  frame.referrerPolicy = 'no-referrer';
  frame.src = embedUrl(base, 'popup', siteOrigin);
  window.addEventListener('message', event => {
    const incoming = acceptEmbedMessage(event, frame?.contentWindow, panelOrigin);
    if (incoming?.type === 'ready') { ready = true; post(); }
    else if (incoming?.type === 'settings') store(incoming.settings).catch(error => { status.textContent = message(error); });
  });
  embed.append(frame);
  embed.hidden = false;
  document.body.classList.add('framed');
}

async function load() {
  try {
    const settings = await readSettings();
    void syncBubbleScript().catch(() => undefined);
    if (!settings) { status.textContent = 'Set your Shelf address to get started.'; return; }
    address.textContent = settings.url;
    address.hidden = false;
    home.href = chrome.runtime.getURL('newtab.html');
    manage.href = `${home.href}#manage`;
    links.hidden = false;
    if (!await hasAccess(settings)) { status.textContent = 'Save settings to allow connection checks.'; return; }
    status.textContent = 'Checking connection…';
    await checkConnection(settings.url);
    status.textContent = 'Shelf is responding';
    status.classList.add('connected');
    await mountEmbed(appBaseUrl(settings.url));
  } catch (error) { status.textContent = message(error); }
}
void load();
