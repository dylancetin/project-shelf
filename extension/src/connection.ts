import { chrome, hasAccess, type ContentScript } from './browser';
import { appBaseUrl, bridgeUrl, type ExtensionSettings } from './core';
import { BRIDGE_CHANNEL, BRIDGE_SCRIPT_ID, type BridgeReply } from './protocol';

export async function registerBridge(settings: ExtensionSettings): Promise<void> {
  if (!await hasAccess(settings)) throw new Error('Allow access to your server in Extension connection settings.');
  const url = new URL(bridgeUrl(settings.url));
  const match = `${url.protocol}//${url.hostname}${url.pathname}`;
  const desired: ContentScript = { id: BRIDGE_SCRIPT_ID, matches: [match],
    js: ['bridge.js'], allFrames: true, runAt: 'document_end', persistAcrossSessions: true };
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
  if (scripts[0]?.matches[0] === match) return;
  if (scripts.length) await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
  try { await chrome.scripting.registerContentScripts([desired]); }
  catch (error) {
    // Two new tabs may initialize together. A matching registration is enough.
    const current = await chrome.scripting.getRegisteredContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
    if (current[0]?.matches[0] !== match) throw error;
  }
}

export class ExtensionConnection {
  private frame: HTMLIFrameElement | null = null;
  private connecting: Promise<void> | null = null;
  private replies = new Map<string, (reply: BridgeReply) => void>();
  private origin: string;
  private cancelledConnection: (() => void) | null = null;
  private closed = false;
  private unload = (event: PageTransitionEvent) => { if (event.persisted) this.disconnect(); else this.close(); };

  constructor(private settings: ExtensionSettings) {
    this.origin = new URL(settings.url).origin;
    window.addEventListener('message', this.receive);
    window.addEventListener('pagehide', this.unload);
  }

  private receive = (event: MessageEvent) => {
    if (event.origin !== this.origin || event.source !== this.frame?.contentWindow || event.data?.channel !== BRIDGE_CHANNEL) return;
    if (event.data.type === 'reply' && typeof event.data.id === 'string') this.replies.get(event.data.id)?.(event.data);
  };

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const connection = (async () => {
      await registerBridge(this.settings);
      if (this.closed) throw new Error('The server connection was closed.');
      await new Promise<void>((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.hidden = true;
        frame.tabIndex = -1;
        frame.setAttribute('aria-hidden', 'true');
        frame.title = 'Shelf server connection';
        const cleanup = () => { clearTimeout(timeout); window.removeEventListener('message', ready); this.cancelledConnection = null; };
        this.cancelledConnection = () => { cleanup(); frame.remove(); reject(new Error('The server connection was closed.')); };
        const ready = (event: MessageEvent) => {
          if (event.origin === this.origin && event.source === frame.contentWindow && event.data?.channel === BRIDGE_CHANNEL && event.data.type === 'ready') {
            cleanup(); resolve();
          }
        };
        const timeout = setTimeout(() => {
          cleanup(); frame.remove();
          if (this.frame === frame) this.frame = null;
          reject(new Error('The server connection is unavailable. Update Project Shelf on the server, or check the connection in extension settings.'));
        }, 6500);
        window.addEventListener('message', ready);
        this.frame = frame;
        frame.src = bridgeUrl(this.settings.url);
        document.body.append(frame);
      });
    })();
    this.connecting = connection;
    void connection.catch(() => { if (this.connecting === connection) this.connecting = null; });
    return connection;
  }

  request = async (path: string, init: RequestInit): Promise<Response> => {
    init.signal?.throwIfAborted();
    if (this.closed) throw new Error('The server connection was closed.');
    if (!await hasAccess(this.settings)) {
      this.disconnect();
      throw new Error('Allow access to your server in Extension connection settings.');
    }
    await this.connect();
    init.signal?.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const id = crypto.randomUUID();
      const cancel = () => {
        this.frame?.contentWindow?.postMessage({ channel: BRIDGE_CHANNEL, type: 'cancel', id }, this.origin);
        cleanup(); reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const cleanup = () => { this.replies.delete(id); init.signal?.removeEventListener('abort', cancel); };
      this.replies.set(id, reply => {
        cleanup();
        if (reply.error) { reject(new Error(reply.error)); return; }
        if (!Number.isInteger(reply.status) || Number(reply.status) < 200 || Number(reply.status) > 599) { reject(new Error('Invalid server response.')); return; }
        resolve(Response.json(reply.data ?? null, { status: reply.status }));
      });
      init.signal?.addEventListener('abort', cancel, { once: true });
      this.frame?.contentWindow?.postMessage({ channel: BRIDGE_CHANNEL, type: 'request', id, path,
        method: init.method ?? 'GET', ...(typeof init.body === 'string' ? { body: init.body } : {}) }, this.origin);
    });
  };

  asset = (path: string) => new URL(`api${path}`, appBaseUrl(this.settings.url)).href;

  private disconnect() {
    this.cancelledConnection?.();
    this.frame?.remove(); this.frame = null; this.connecting = null;
    for (const [id, reply] of this.replies) reply({ channel: BRIDGE_CHANNEL, type: 'reply', id, error: 'The server connection was closed.' });
  }

  close() {
    this.closed = true;
    this.disconnect();
    window.removeEventListener('message', this.receive);
    window.removeEventListener('pagehide', this.unload);
  }
}
