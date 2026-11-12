import type { TargetView } from './model';

export function RuntimeStatus({ view }: { view: Pick<TargetView, 'phase' | 'statusLabel'> }) {
  return <span className={`status status-${view.phase}`}><span className="status-dot" />{view.statusLabel}</span>;
}

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
