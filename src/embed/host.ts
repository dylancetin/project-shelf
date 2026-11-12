import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BUBBLE_PIXELS, BUBBLE_SETTINGS_KEY, DEFAULT_BUBBLE_SETTINGS, parseBubbleSettings, parseHostToEmbedMessage,
  type BubbleSettings, type EmbedLayout, type EmbedToHostMessage,
} from '../../shared/embed';

const hasHost = () => window.parent !== window;

/** Chromium only. When it is unknown the embed cannot tell who framed it, so it falls back to '*'. */
function parentOrigin(): string | null {
  const first = (location.ancestorOrigins as DOMStringList | undefined)?.[0];
  return first && first !== 'null' ? first : null;
}

type Outgoing = EmbedToHostMessage extends infer Message ? Message extends unknown ? Omit<Message, 'source'> : never : never;

// The payloads are a layout name, the appearance settings and the list of origins the user hid:
// nothing a framing page does not already have, so an unknown parent origin only costs a wildcard target.
function post(message: Outgoing) {
  if (!hasHost()) return;
  const payload = { source: 'project-shelf-embed', ...message };
  try { window.parent.postMessage(payload, parentOrigin() ?? '*'); }
  catch { window.parent.postMessage(payload, '*'); }
}

function readStored(): BubbleSettings {
  try {
    const raw = localStorage.getItem(BUBBLE_SETTINGS_KEY);
    return parseBubbleSettings(raw ? JSON.parse(raw) : null);
  } catch { return DEFAULT_BUBBLE_SETTINGS; }
}

function writeStored(settings: BubbleSettings) {
  try { localStorage.setItem(BUBBLE_SETTINGS_KEY, JSON.stringify(settings)); }
  catch { /* Storage can be blocked in a third-party frame; the host copy is the one that persists. */ }
}

const SEND_DELAY_MS = 150;
// A host echoes every saved settings message back. Applying an echo of an older edit while the user is
// still dragging a slider would move the control backwards, so echoes just after a local edit are ignored.
const ECHO_QUIET_MS = 450;

export interface HostSettings {
  settings: BubbleSettings;
  /** Tells the host what size to give the frame. */
  setLayout: (layout: EmbedLayout) => void;
  update: (patch: Partial<BubbleSettings>) => void;
  resetAppearance: () => void;
  hideOrigin: (origin: string) => void;
  showOrigin: (origin: string) => void;
}

/**
 * Settings and layout for the framed page. Without a host (the page opened on its own) settings live only in
 * localStorage; with one, localStorage is just the first paint and the host's copy replaces it.
 */
export function useEmbedHost(): HostSettings {
  const [settings, setSettings] = useState<BubbleSettings>(readStored);
  const latest = useRef(settings);
  const lastEdit = useRef(0);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const layoutRef = useRef<EmbedLayout>('hidden');
  const hostSeen = useRef(false);

  const flush = useCallback(() => {
    if (sendTimer.current === undefined) return;
    clearTimeout(sendTimer.current);
    sendTimer.current = undefined;
    writeStored(latest.current);
    post({ type: 'settings', settings: latest.current });
  }, []);

  useEffect(() => {
    if (!hasHost()) return;
    const expected = parentOrigin();
    function receive(event: MessageEvent) {
      if (event.source !== window.parent || (expected !== null && event.origin !== expected)) return;
      const message = parseHostToEmbedMessage(event.data);
      if (!message) return;
      // The first answer shows the host is listening; it may have missed the layout sent before that.
      if (!hostSeen.current) { hostSeen.current = true; post({ type: 'layout', layout: layoutRef.current }); }
      if (sendTimer.current !== undefined || Date.now() - lastEdit.current < ECHO_QUIET_MS) return;
      latest.current = message.settings;
      setSettings(message.settings);
      writeStored(message.settings);
    }
    window.addEventListener('message', receive);
    window.addEventListener('pagehide', flush);
    post({ type: 'ready' });
    return () => { window.removeEventListener('message', receive); window.removeEventListener('pagehide', flush); flush(); };
  }, [flush]);

  const setLayout = useCallback((layout: EmbedLayout) => {
    layoutRef.current = layout;
    post({ type: 'layout', layout });
  }, []);

  const update = useCallback((patch: Partial<BubbleSettings>) => {
    const next = parseBubbleSettings({ ...latest.current, ...patch });
    latest.current = next;
    lastEdit.current = Date.now();
    setSettings(next);
    clearTimeout(sendTimer.current);
    sendTimer.current = setTimeout(flush, SEND_DELAY_MS);
  }, [flush]);

  // Hidden sites are a list the user manages separately; resetting appearance must not bring them all back.
  const resetAppearance = useCallback(() => update({ ...DEFAULT_BUBBLE_SETTINGS, hiddenOrigins: latest.current.hiddenOrigins }), [update]);
  const hideOrigin = useCallback((origin: string) => update({ hiddenOrigins: [...new Set([...latest.current.hiddenOrigins, origin])] }), [update]);
  const showOrigin = useCallback((origin: string) => update({ hiddenOrigins: latest.current.hiddenOrigins.filter(item => item !== origin) }), [update]);
  return { settings, setLayout, update, resetAppearance, hideOrigin, showOrigin };
}

const SETTLE_TIMEOUT_MS = 600;
const SIZE_SLACK = 12;

/**
 * False while the host is still resizing the frame to `layout`. Drawing the panel into a bubble-sized frame (or the
 * bubble into a panel-sized one) for the frame or two before the resize lands reads as a flash, so drawing waits.
 * A host that never resizes is not waited for beyond a short timeout.
 */
export function useFrameSettled(layout: EmbedLayout): boolean {
  const [width, setWidth] = useState(() => window.innerWidth);
  // The timeout belongs to one layout; deriving it during render means a new layout is never briefly "expired".
  const [wait, setWait] = useState({ layout, expired: false });
  if (wait.layout !== layout) setWait({ layout, expired: false });
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setWait(current => current.layout === layout ? { layout, expired: true } : current), SETTLE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [layout]);
  if (!hasHost() || (wait.layout === layout && wait.expired) || layout === 'hidden') return true;
  const bubbleMax = BUBBLE_PIXELS.large + SIZE_SLACK;
  return layout === 'bubble' ? width <= bubbleMax : width > bubbleMax;
}
