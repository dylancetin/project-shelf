import type { Ref } from 'react';
import type { BubbleSize } from '../../shared/embed';
import { BUBBLE_PIXELS } from '../../shared/embed';
import { ProjectAvatar } from '../components';
import { countLabel, type TargetView } from './model';

/** Fills the whole frame; the host owns the frame's size, position and idle opacity. */
export function Bubble({ view, size, unseenErrors, onOpen, buttonRef }: {
  view: TargetView;
  size: BubbleSize;
  /** Error lines since the panel was last open, or 0 when the badge is off. */
  unseenErrors: number;
  onOpen: () => void;
  buttonRef: Ref<HTMLButtonElement>;
}) {
  const errors = unseenErrors > 0 ? `, ${unseenErrors} new error ${unseenErrors === 1 ? 'line' : 'lines'}` : '';
  const label = `Project Shelf controls for ${view.name}, ${view.statusLabel.toLowerCase()}${errors}`;
  return <button ref={buttonRef} type="button" className="embed-bubble" style={{ '--bubble': `${BUBBLE_PIXELS[size]}px` } as React.CSSProperties}
    aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={false} onClick={onOpen}>
    <ProjectAvatar project={view.avatar} />
    <span className={`bubble-dot bubble-${view.phase}`} aria-hidden="true" />
    {unseenErrors > 0 && <span className="bubble-badge" aria-hidden="true">{countLabel(unseenErrors)}</span>}
  </button>;
}
