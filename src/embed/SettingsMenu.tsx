import { useEffect, useId, useRef, useState } from 'react';
import { ArrowCounterClockwise, EyeSlash, GearSix, X } from '@phosphor-icons/react';
import { BUBBLE_PIXELS, type BubbleCorner, type BubbleSettings, type BubbleSize, type EmbedSurface, type EmbedTab } from '../../shared/embed';
import { IconButton } from '../components';
import type { HostSettings } from './host';

const CORNERS: { value: BubbleCorner; label: string }[] = [
  { value: 'bottom-right', label: 'Bottom right' }, { value: 'bottom-left', label: 'Bottom left' },
  { value: 'top-right', label: 'Top right' }, { value: 'top-left', label: 'Top left' },
];
const SIZES: BubbleSize[] = ['small', 'medium', 'large'];
const TABS: { value: EmbedTab; label: string }[] = [{ value: 'controls', label: 'Controls' }, { value: 'logs', label: 'Logs' }];

/** The gear and the popover it opens. Escape closes the popover before anything behind it sees the key. */
export function SettingsMenu({ host, surface, pageUrl }: { host: HostSettings; surface: EmbedSurface; pageUrl: URL | null }) {
  const [open, setOpen] = useState(false);
  const gear = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { settings, update } = host;
  const origin = pageUrl?.origin ?? null;
  const hiddenHere = origin !== null && settings.hiddenOrigins.includes(origin);

  useEffect(() => {
    if (!open) return;
    popover.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      gear.current?.focus();
    }
    function pointerdown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && !popover.current?.contains(target) && !gear.current?.contains(target)) setOpen(false);
    }
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', pointerdown, true);
    return () => { document.removeEventListener('keydown', keydown, true); document.removeEventListener('pointerdown', pointerdown, true); };
  }, [open]);

  return <>
    <IconButton ref={gear} label="Bubble settings" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? titleId : undefined} className={open ? 'selected' : ''} onClick={() => setOpen(value => !value)}>
      <GearSix size={18} aria-hidden="true" />
    </IconButton>
    {open && <div ref={popover} id={titleId} role="dialog" aria-label="Bubble settings" className="embed-settings">
      <div className="embed-settings-heading"><h3>Bubble settings</h3><IconButton label="Close settings" onClick={() => { setOpen(false); gear.current?.focus(); }}><X size={16} aria-hidden="true" /></IconButton></div>
      <div className="embed-setting"><label htmlFor={`${titleId}-corner`}>Corner</label>
        <select id={`${titleId}-corner`} data-autofocus value={settings.corner} onChange={event => update({ corner: CORNERS.find(item => item.value === event.target.value)?.value ?? settings.corner })}>
          {CORNERS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select></div>
      <Segmented legend="Size" value={settings.size} options={SIZES.map(value => ({ value, label: `${value[0]?.toUpperCase()}${value.slice(1)}`, title: `${BUBBLE_PIXELS[value]} px` }))} onChange={size => update({ size })} />
      <div className="embed-setting"><label htmlFor={`${titleId}-opacity`}>Idle opacity</label>
        <span className="embed-range"><input id={`${titleId}-opacity`} type="range" min={0.3} max={1} step={0.05} value={settings.idleOpacity} onChange={event => update({ idleOpacity: event.target.valueAsNumber })} aria-valuetext={`${Math.round(settings.idleOpacity * 100)} percent`} /><output htmlFor={`${titleId}-opacity`}>{Math.round(settings.idleOpacity * 100)}%</output></span></div>
      <div className="embed-setting-pair">
        <NumberSetting id={`${titleId}-x`} label="Offset X" value={settings.offsetX} onCommit={offsetX => update({ offsetX })} />
        <NumberSetting id={`${titleId}-y`} label="Offset Y" value={settings.offsetY} onCommit={offsetY => update({ offsetY })} />
      </div>
      <label className="embed-check"><input type="checkbox" checked={settings.showLogBadge} onChange={event => update({ showLogBadge: event.target.checked })} /><span>Show a count of new error lines on the bubble</span></label>
      <Segmented legend="Open on" value={settings.defaultTab} options={TABS} onChange={defaultTab => update({ defaultTab })} />
      <div className="embed-settings-site">
        <button type="button" className="button" disabled={origin === null || hiddenHere} onClick={() => origin && host.hideOrigin(origin)}
          title={origin === null ? 'This page has no address to hide' : hiddenHere ? 'Already hidden on this site' : `Stop showing the bubble on ${origin}`}>
          <EyeSlash size={15} aria-hidden="true" />{hiddenHere ? 'Hidden on this site' : 'Hide on this site'}
        </button>
        <p>{origin === null ? 'There is no site to hide for this tab.' : surface === 'bubble' ? 'Bring it back from the extension popup.' : `Applies to ${pageUrl?.host}.`}</p>
      </div>
      {surface === 'popup' && <HiddenSites origins={settings.hiddenOrigins} onShow={host.showOrigin} />}
      <div className="embed-settings-reset"><button type="button" className="button" onClick={host.resetAppearance} title="Restore corner, size, opacity, offsets, badge and tab. Hidden sites are kept."><ArrowCounterClockwise size={15} aria-hidden="true" />Reset to defaults</button></div>
    </div>}
  </>;
}

function Segmented<T extends string>({ legend, value, options, onChange }: { legend: string; value: T; options: { value: T; label: string; title?: string }[]; onChange: (value: T) => void }) {
  const labelId = useId();
  return <div className="embed-setting"><span id={labelId} className="embed-setting-label">{legend}</span>
    <span className="embed-segmented" role="radiogroup" aria-labelledby={labelId}>{options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value} title={option.title} className={option.value === value ? 'selected' : ''} onClick={() => onChange(option.value)}>{option.label}</button>)}</span>
  </div>;
}

// Typing is held as text until it is a number, so the field can be cleared and retyped.
function NumberSetting({ id, label, value, onCommit }: { id: string; label: string; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <div className="embed-number"><label htmlFor={id}>{label}</label>
    <span><input id={id} type="number" inputMode="numeric" min={0} max={400} step={1} value={draft ?? String(value)}
      onChange={event => { setDraft(event.target.value); if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) onCommit(event.target.valueAsNumber); }}
      onBlur={() => setDraft(null)} /><span aria-hidden="true">px</span></span></div>;
}

function HiddenSites({ origins, onShow }: { origins: BubbleSettings['hiddenOrigins']; onShow: (origin: string) => void }) {
  return <div className="embed-hidden-sites"><h4>Hidden sites</h4>
    {origins.length ? <ul>{origins.map(origin => <li key={origin}><span title={origin}>{origin}</span><IconButton label={`Show the bubble on ${origin} again`} onClick={() => onShow(origin)}><X size={14} aria-hidden="true" /></IconButton></li>)}</ul>
      : <p>The bubble is shown on every site that runs one of your projects.</p>}
  </div>;
}
