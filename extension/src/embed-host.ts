import { parseEmbedToHostMessage, type BubbleSettings, type EmbedToHostMessage } from '../../shared/embed';

export interface EmbedEventLike { source: unknown; origin: string; data: unknown }

/**
 * A message counts only when it comes from our own frame's window at the panel origin and has the
 * contract's shape. A detached frame has no window, and `null === null` must not pass.
 */
export function acceptEmbedMessage(event: EmbedEventLike, frameWindow: unknown, panelOrigin: string): EmbedToHostMessage | null {
  if (!frameWindow || event.source !== frameWindow || event.origin !== panelOrigin) return null;
  return parseEmbedToHostMessage(event.data);
}

export function withoutHiddenOrigin(settings: BubbleSettings, origin: string): BubbleSettings {
  return { ...settings, hiddenOrigins: settings.hiddenOrigins.filter(item => item !== origin) };
}
