import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowClockwise, Check, Copy, Eraser, MagnifyingGlass, TextAlignLeft, X } from '@phosphor-icons/react';
import { copyText } from '../clipboard';
import { IconButton, Spinner } from '../components';
import { entriesAfter, filterEntries, markEnd, type ClearMark, type LogEntry, type StreamFilter } from './model';

const STREAMS: { value: StreamFilter; label: string }[] = [{ value: 'all', label: 'All' }, { value: 'stdout', label: 'stdout' }, { value: 'stderr', label: 'stderr' }];
const AT_BOTTOM_PX = 16;

export interface LogsProps {
  name: string;
  /** Null until the first answer. */
  entries: LogEntry[] | null;
  error: string | null;
  /** Whether the tab is showing; a hidden tab keeps its filters and clear mark but does not scroll. */
  active: boolean;
  mark: ClearMark | null;
  onMark: (mark: ClearMark | null) => void;
  onRefresh: () => void;
}

export function Logs({ name, entries, error, active, mark, onMark, onRefresh }: LogsProps) {
  const [query, setQuery] = useState('');
  const [stream, setStream] = useState<StreamFilter>('all');
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const received = useMemo(() => entriesAfter(entries ?? [], mark), [entries, mark]);
  const shown = useMemo(() => filterEntries(received, query, stream), [received, query, stream]);
  const cleared = (entries?.length ?? 0) - received.length;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!active || !follow || !element) return;
    element.scrollTop = element.scrollHeight;
    lastTop.current = element.scrollTop;
  }, [shown, follow, wrap, active]);

  // Only moving up pauses following. Our own pinning and growing content never move the view up, so a stray
  // scroll event cannot pause it; reaching the bottom again (or "Latest") resumes.
  const lastTop = useRef(0);
  function onScroll() {
    const element = scroller.current;
    if (!element || !active) return;
    const movedUp = element.scrollTop < lastTop.current;
    lastTop.current = element.scrollTop;
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_PX) setFollow(true);
    else if (movedUp) setFollow(false);
  }
  async function copy() {
    if (await copyText(shown.map(entry => entry.text).join('\n'))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }

  return <div className="embed-logs">
    <div className="embed-log-tools">
      <label className="embed-search"><MagnifyingGlass size={14} aria-hidden="true" /><span className="sr-only">Filter log lines</span>
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter lines" spellCheck={false} />
        {query && <IconButton label="Clear filter" onClick={() => setQuery('')}><X size={13} aria-hidden="true" /></IconButton>}
      </label>
      <div className="embed-streams" role="radiogroup" aria-label="Output stream">
        {STREAMS.map(item => <button key={item.value} type="button" role="radio" aria-checked={stream === item.value} className={stream === item.value ? 'selected' : ''} onClick={() => setStream(item.value)}>{item.label}</button>)}
      </div>
      <div className="embed-log-buttons">
        <IconButton label={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'} aria-pressed={wrap} className={wrap ? 'selected' : ''} onClick={() => setWrap(value => !value)}><TextAlignLeft size={16} aria-hidden="true" /></IconButton>
        <IconButton label={copied ? 'Copied' : 'Copy visible lines'} disabled={!shown.length} onClick={() => void copy()}>{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}</IconButton>
        <IconButton label="Clear view" title="Hide everything received so far. The server keeps its log." disabled={!received.length} onClick={() => onMark(markEnd(entries ?? []))}><Eraser size={16} aria-hidden="true" /></IconButton>
        <IconButton label="Refresh logs" onClick={onRefresh}><ArrowClockwise size={16} aria-hidden="true" /></IconButton>
      </div>
    </div>
    {error && <p className="embed-log-error" role="alert">{entries ? 'Could not refresh logs: ' : 'Could not load logs: '}{error}</p>}
    <div className="embed-log-frame">
      <div ref={scroller} className={`embed-log${wrap ? '' : ' nowrap'}`} role="log" aria-live="off" aria-label={`Log output for ${name}`} tabIndex={0} onScroll={onScroll}>
        {entries === null ? (error ? null : <p className="embed-log-empty"><Spinner size={16} />Reading output…</p>)
          : shown.length ? shown.map(entry => <div key={entry.key} className={`embed-log-line log-${entry.stream}`}><time>{entry.time}</time><span>{entry.text}</span></div>)
          : <p className="embed-log-empty">{received.length ? 'No lines match the filter.' : cleared ? 'View cleared. New output appears here.' : 'No output yet.'}</p>}
      </div>
      {!follow && shown.length > 0 && <button type="button" className="button embed-jump" onClick={() => setFollow(true)}><ArrowDown size={13} aria-hidden="true" />Latest</button>}
    </div>
    <div className="embed-log-footer">
      <span>{shown.length} {shown.length === 1 ? 'line' : 'lines'}{shown.length !== received.length ? ` of ${received.length}` : ''}</span>
      {cleared > 0 && <button type="button" className="text-button" onClick={() => onMark(null)}>Show {cleared} cleared</button>}
      <span className="embed-follow">{follow ? 'Following' : 'Paused'}</span>
    </div>
  </div>;
}
