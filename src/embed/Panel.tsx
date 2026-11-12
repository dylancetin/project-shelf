import { useEffect, useId, useRef, type KeyboardEvent, type Ref } from 'react';
import { ArrowLeft, WifiSlash, X } from '@phosphor-icons/react';
import type { EmbedSurface, EmbedTab } from '../../shared/embed';
import type { RuntimeTarget } from '../../shared/runtime-targets';
import { IconButton, ProjectAvatar } from '../components';
import { Controls } from './Controls';
import type { HostSettings } from './host';
import { Logs, type LogsProps } from './Logs';
import { describeTarget, MODE_LABEL, targetKey, type TargetKey } from './model';
import { RuntimeStatus } from './parts';
import { SettingsMenu } from './SettingsMenu';

const TAB_LABEL: Record<EmbedTab, string> = { controls: 'Controls', logs: 'Logs' };
const TABS: EmbedTab[] = ['controls', 'logs'];

export interface PanelProps {
  surface: EmbedSurface;
  pageUrl: URL | null;
  host: HostSettings;
  targets: RuntimeTarget[];
  selected: RuntimeTarget;
  tab: EmbedTab;
  /** Runtimes the frame cannot refresh right now. */
  offline: boolean;
  hostnames: readonly string[] | null;
  logs: Omit<LogsProps, 'name' | 'active'>;
  /** What the close button does: collapse to the bubble, or go back to the popup's list. Absent when there is nowhere to go. */
  exit: { label: string; icon: 'close' | 'back'; run: () => void } | null;
  panelRef: Ref<HTMLDivElement>;
  onTab: (tab: EmbedTab) => void;
  onSelect: (key: TargetKey) => void;
  onChanged: (target: RuntimeTarget) => void;
  onRemoved: (key: TargetKey) => void;
}

export function Panel(props: PanelProps) {
  const { surface, pageUrl, host, targets, selected, tab, offline, exit } = props;
  const view = describeTarget(selected);
  const ids = useId();
  const tabRefs = useRef<Partial<Record<EmbedTab, HTMLButtonElement | null>>>({});
  const exitRun = useRef(exit?.run);
  exitRun.current = exit?.run;

  // Escape collapses the panel. The settings menu handles it first, in the capture phase, when it is open.
  useEffect(() => {
    function keydown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || !exitRun.current) return;
      event.preventDefault();
      exitRun.current();
    }
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, []);

  function tabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length];
    if (!next) return;
    props.onTab(next);
    tabRefs.current[next]?.focus();
  }

  return <div ref={props.panelRef} className="embed-card" role="dialog" aria-label={`Project Shelf controls for ${view.name}`} tabIndex={-1}>
    <header className="embed-header">
      {exit?.icon === 'back' && <IconButton label={exit.label} onClick={exit.run}><ArrowLeft size={18} aria-hidden="true" /></IconButton>}
      <ProjectAvatar project={view.avatar} />
      <div className="embed-title">
        <h2 title={view.name}>{view.name}</h2>
        <div className="embed-meta">
          <RuntimeStatus view={view} />
          {view.mode && view.phase !== 'stopped' && <span>{MODE_LABEL[view.mode]}</span>}
          {view.kind === 'agent' && <span>Agent preview</span>}
          {view.port !== null && <span className="mono">:{view.port}</span>}
        </div>
      </div>
      <SettingsMenu host={host} surface={surface} pageUrl={pageUrl} />
      {exit?.icon === 'close' && <IconButton label={exit.label} onClick={exit.run}><X size={18} aria-hidden="true" /></IconButton>}
    </header>
    {targets.length > 1 && <label className="embed-chooser"><span className="sr-only">Runtime serving this page</span>
      <select value={view.key} onChange={event => props.onSelect(event.target.value)}>
        {targets.map(target => {
          const item = describeTarget(target);
          return <option key={targetKey(target)} value={item.key}>{item.name} — {item.statusLabel.toLowerCase()}{item.port !== null ? ` · :${item.port}` : ''}</option>;
        })}
      </select></label>}
    {offline && <p className="embed-offline" role="status"><WifiSlash size={14} aria-hidden="true" />Can’t reach Project Shelf. Showing the last state; retrying.</p>}
    <div className="embed-tabs" role="tablist" aria-label="Sections">
      {TABS.map(item => <button key={item} ref={node => { tabRefs.current[item] = node; }} type="button" role="tab" id={`${ids}-tab-${item}`} aria-selected={tab === item} aria-controls={`${ids}-panel-${item}`}
        tabIndex={tab === item ? 0 : -1} className={tab === item ? 'selected' : ''} onClick={() => props.onTab(item)} onKeyDown={tabKey}>{TAB_LABEL[item]}</button>)}
    </div>
    <div role="tabpanel" id={`${ids}-panel-controls`} aria-labelledby={`${ids}-tab-controls`} hidden={tab !== 'controls'} className="embed-tabpanel">
      <Controls target={selected} hostnames={props.hostnames} pageHost={pageUrl?.hostname ?? null} onChanged={props.onChanged} onRemoved={props.onRemoved} />
    </div>
    <div role="tabpanel" id={`${ids}-panel-logs`} aria-labelledby={`${ids}-tab-logs`} hidden={tab !== 'logs'} className="embed-tabpanel embed-tabpanel-logs">
      <Logs key={view.key} name={view.name} active={tab === 'logs'} {...props.logs} />
    </div>
  </div>;
}
