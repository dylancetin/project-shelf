import { BUBBLE_SETTINGS_KEY, DEFAULT_BUBBLE_SETTINGS, embedUrl, parseBubbleSettings, type BubbleSettings, type EmbedLayout, type HostToEmbedMessage } from '../../shared/embed';
import { chrome, type StorageChanges } from './browser';
import { canHostBubble } from './bubble-hosts';
import { appBaseUrl, parseSettings, SETTINGS_KEY } from './core';
import { acceptEmbedMessage } from './embed-host';
import { frameOpacity, frameRect } from './frame-rect';

const MARKER = 'data-project-shelf-bubble';
const TAKEOVER = 'project-shelf-bubble-takeover';

(() => {
  if (!(document.documentElement instanceof HTMLHtmlElement) || window.top !== window) return;

  let alive = true;
  let panel: URL | null = null;
  let settings: BubbleSettings = DEFAULT_BUBBLE_SETTINGS;
  let layout: EmbedLayout = 'hidden';
  let pointerOver = false;
  let ready = false;
  let posted = '';
  let frame: HTMLIFrameElement | null = null;
  let host: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  let resizeFrame = 0;

  // Inline !important beats page rules, and CSSOM writes are not subject to a page's style CSP.
  const style = (el: HTMLElement, props: Record<string, string>) => { for (const [name, value] of Object.entries(props)) el.style.setProperty(name, value, 'important'); };
  const px = (value: number | undefined) => (value === undefined ? 'auto' : `${value}px`);

  function place() {
    if (!host) return;
    const root = document.documentElement;
    const standards = document.compatMode === 'CSS1Compat';
    const rect = frameRect(layout, settings, { width: standards ? root.clientWidth : innerWidth, height: standards ? root.clientHeight : innerHeight });
    style(host, { display: rect.visible ? 'block' : 'none', width: px(rect.width), height: px(rect.height),
      top: px(rect.top), bottom: px(rect.bottom), left: px(rect.left), right: px(rect.right),
      opacity: String(frameOpacity(layout, settings, pointerOver)) });
  }

  function push() {
    if (!ready || !panel || !frame?.contentWindow) return;
    const json = JSON.stringify(settings);
    if (json === posted) return;
    posted = json;
    const message: HostToEmbedMessage = { source: 'project-shelf-host', type: 'settings', settings };
    frame.contentWindow.postMessage(message, panel.origin);
  }

  async function save(next: BubbleSettings) {
    try { await chrome.storage.local.set({ [BUBBLE_SETTINGS_KEY]: next }); } catch { return; }
    settings = next;
    apply();
  }

  function onMessage(event: MessageEvent) {
    const message = panel && acceptEmbedMessage(event, frame?.contentWindow, panel.origin);
    if (!message) return;
    if (message.type === 'ready') {
      // A fresh document knows nothing: it is hidden again until it reports a layout.
      ready = true; posted = ''; layout = 'hidden';
      place(); push();
    } else if (message.type === 'layout') {
      layout = message.layout;
      place();
    } else void save(message.settings);
  }

  // A press inside the frame is delivered to the framed document only, so any press this page sees is outside the panel.
  function onPagePointerDown() {
    if (layout !== 'panel' || !panel) return;
    const message: HostToEmbedMessage = { source: 'project-shelf-host', type: 'collapse' };
    frame?.contentWindow?.postMessage(message, panel.origin);
  }

  const onResize = () => { resizeFrame ||= requestAnimationFrame(() => { resizeFrame = 0; place(); }); };
  const onEnter = () => { pointerOver = true; place(); };
  const onLeave = () => { pointerOver = false; place(); };

  function mount() {
    unmount();
    if (!panel) return;
    // A previous run can leave its element behind when the extension reloads under a live page.
    for (const stale of document.querySelectorAll(`[${MARKER}]`)) stale.remove();
    host = document.createElement('project-shelf-bubble');
    host.setAttribute(MARKER, '');
    style(host, { all: 'initial', position: 'fixed', 'z-index': '2147483647', 'color-scheme': 'light', background: 'transparent', display: 'none',
      transition: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'opacity .15s ease' });
    frame = document.createElement('iframe');
    frame.title = 'Project Shelf';
    frame.setAttribute('allow', 'clipboard-write');
    frame.referrerPolicy = 'no-referrer';
    style(frame, { display: 'block', width: '100%', height: '100%', border: '0', margin: '0', padding: '0', background: 'transparent', 'color-scheme': 'light' });
    frame.src = embedUrl(appBaseUrl(panel.href), 'bubble', location.origin);
    host.attachShadow({ mode: 'closed' }).append(frame);
    window.addEventListener('message', onMessage);
    window.addEventListener('resize', onResize);
    document.addEventListener('pointerdown', onPagePointerDown, true);
    host.addEventListener('pointerenter', onEnter);
    host.addEventListener('pointerleave', onLeave);
    // Frameworks that rebuild <html>'s children must not take the bubble with them.
    observer = new MutationObserver(() => { if (host && !host.isConnected) document.documentElement.append(host); });
    observer.observe(document.documentElement, { childList: true });
    place();
    document.documentElement.append(host);
  }

  function unmount() {
    observer?.disconnect(); observer = null;
    window.removeEventListener('message', onMessage);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('pointerdown', onPagePointerDown, true);
    host?.remove(); host = null; frame = null;
    layout = 'hidden'; ready = false; posted = ''; pointerOver = false;
  }

  function apply() {
    if (!alive) return;
    if (!panel || settings.hiddenOrigins.includes(location.origin)) { unmount(); return; }
    if (!host) mount(); else place();
    push();
  }

  async function load() {
    let next: URL | null = null;
    let stored: Record<string, unknown> = {};
    try {
      stored = await chrome.storage.local.get([SETTINGS_KEY, BUBBLE_SETTINGS_KEY]);
      const configured = parseSettings(stored[SETTINGS_KEY]);
      const base = configured && new URL(appBaseUrl(configured.url));
      next = base && canHostBubble(location, base) ? base : null;
    } catch { /* No usable server address or no extension context: stay invisible. */ }
    if (!alive) return;
    settings = parseBubbleSettings(stored[BUBBLE_SETTINGS_KEY]);
    if (panel?.href !== next?.href) unmount();
    panel = next;
    apply();
  }

  function onChanged(changes: StorageChanges, area: string) {
    if (!alive || area !== 'local') return;
    if (SETTINGS_KEY in changes) void load();
    else if (BUBBLE_SETTINGS_KEY in changes) { settings = parseBubbleSettings(changes[BUBBLE_SETTINGS_KEY]?.newValue); apply(); }
  }

  function destroy() {
    alive = false;
    unmount();
    document.removeEventListener(TAKEOVER, destroy);
    try { chrome.storage.onChanged.removeListener(onChanged); } catch { /* The extension context is already gone. */ }
  }

  // Another run on this page (duplicate registration, extension reload) hands over to this one.
  document.dispatchEvent(new CustomEvent(TAKEOVER));
  document.addEventListener(TAKEOVER, destroy);
  chrome.storage.onChanged.addListener(onChanged);
  void load();
})();
