import { CaretRight, Play } from '@phosphor-icons/react';
import type { RuntimeTarget } from '../../shared/runtime-targets';
import { ProjectAvatar } from '../components';
import { describeTarget, MODE_LABEL, type TargetKey } from './model';
import { RuntimeStatus } from './parts';

/** The popup's answer when nothing registered serves the active tab: every active runtime, to pick from. */
export function RuntimeList({ runtimes, pageHost, agentsError, onPick }: {
  runtimes: RuntimeTarget[];
  /** Host and port of the tab that matched nothing; null when the tab has no web address. */
  pageHost: string | null;
  agentsError: string | null;
  onPick: (key: TargetKey) => void;
}) {
  return <div className="embed-list">
    <p className="embed-list-note">{pageHost ? <>Nothing registered serves <strong>{pageHost}</strong>.</> : 'This tab is not a web page.'}</p>
    {agentsError && <p className="embed-list-note embed-list-warning" role="status">Agent previews could not be listed: {agentsError}</p>}
    {runtimes.length ? <ul aria-label="Active runtimes">{runtimes.map(runtime => {
      const view = describeTarget(runtime);
      return <li key={view.key}>
        <button type="button" className="embed-runtime" onClick={() => onPick(view.key)} aria-label={`${view.name}, ${view.statusLabel.toLowerCase()}. Open controls`}>
          <ProjectAvatar project={view.avatar} />
          <span className="embed-runtime-text">
            <strong>{view.name}</strong>
            <span>{view.kind === 'agent' ? 'Agent preview' : view.mode ? MODE_LABEL[view.mode] : 'Project'}{view.port !== null && <> · <span className="mono">:{view.port}</span></>}</span>
          </span>
          <RuntimeStatus view={view} />
          <CaretRight size={14} aria-hidden="true" />
        </button>
      </li>;
    })}</ul>
      : <div className="embed-empty"><span className="empty-icon"><Play size={22} aria-hidden="true" /></span>
        <h3>Nothing is running.</h3>
        <p>Start a project from Manage and it will be listed here.</p>
        <a className="button" href="/#manage" target="_blank" rel="noreferrer">Open Manage</a></div>}
  </div>;
}
