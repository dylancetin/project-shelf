import { BUBBLE_PIXELS, PANEL_SIZE, type BubbleSettings, type EmbedLayout } from '../../shared/embed';

export interface Viewport { width: number; height: number }

/** Exactly one of top/bottom and one of left/right is set when `visible`. Values are CSS pixels. */
export interface FrameRect {
  visible: boolean;
  width: number;
  height: number;
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

/** Space the panel keeps from the opposite edges so it never touches the window border. */
export const PANEL_MARGIN = 8;

const HIDDEN: FrameRect = { visible: false, width: 0, height: 0 };
const whole = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

export function frameRect(layout: EmbedLayout, settings: BubbleSettings, viewport: Viewport): FrameRect {
  if (layout === 'hidden') return HIDDEN;
  const vw = whole(viewport.width);
  const vh = whole(viewport.height);
  const panel = layout === 'panel';
  const side = BUBBLE_PIXELS[settings.size];
  const width = panel ? Math.min(PANEL_SIZE.width, Math.max(0, vw - 2 * PANEL_MARGIN)) : Math.min(side, vw);
  const height = panel ? Math.min(PANEL_SIZE.height, Math.max(0, vh - 2 * PANEL_MARGIN)) : Math.min(side, vh);
  // The panel also keeps its margin on the far side when the window is narrower than the offset allows.
  const farMargin = panel ? PANEL_MARGIN : 0;
  const x = clamp(settings.offsetX, 0, vw - width - farMargin);
  const y = clamp(settings.offsetY, 0, vh - height - farMargin);
  const rect: FrameRect = { visible: true, width, height };
  if (settings.corner.endsWith('left')) rect.left = x; else rect.right = x;
  if (settings.corner.startsWith('top')) rect.top = y; else rect.bottom = y;
  return rect;
}

/** Only the idle bubble fades; the open panel is always fully opaque. */
export function frameOpacity(layout: EmbedLayout, settings: BubbleSettings, pointerOver: boolean): number {
  return layout === 'bubble' && !pointerOver ? settings.idleOpacity : 1;
}
