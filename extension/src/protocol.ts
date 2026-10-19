export const BRIDGE_CHANNEL = 'project-shelf-extension-v1';
export const BRIDGE_SCRIPT_ID = 'project-shelf-api-bridge';

export interface BridgeRequest { channel: typeof BRIDGE_CHANNEL; type: 'request'; id: string; path: string; method: string; body?: string }
export interface BridgeReply { channel: typeof BRIDGE_CHANNEL; type: 'reply'; id: string; status?: number; data?: unknown; error?: string }

export function validApiRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.channel === BRIDGE_CHANNEL && item.type === 'request'
    && typeof item.id === 'string' && /^[a-f0-9-]{36}$/.test(item.id)
    && typeof item.path === 'string'
    && /^\/(?:health|settings|scan|bookmarks\/import|agent-servers(?:\/[a-f0-9-]+(?:\/logs)?)?|projects(?:\/[a-zA-Z0-9_-]+(?:\/(?:launch|start|stop|logs|duplicate|logos))?)?)$/.test(item.path)
    && typeof item.method === 'string' && ['GET', 'POST', 'PATCH', 'DELETE'].includes(item.method)
    && (item.body === undefined || (typeof item.body === 'string' && item.body.length <= 5 * 1024 * 1024));
}

export function trustedParent(origin: string, extensionId: string, source: MessageEventSource | null, parent: Window): boolean {
  return origin === `chrome-extension://${extensionId}` && source === parent;
}
