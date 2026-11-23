import { Fragment, useId, type Ref } from 'react';
import { ArrowUpRight, GlobeSimple, LockSimple } from '@phosphor-icons/react';
import { MAX_TUNNEL_ALLOWED_EMAILS, parseTunnelAccess, type TunnelAccess, type TunnelAccessMode, type TunnelAccessRef } from '../shared/tunnels';
import type { Project } from '../shared/types';

const MODE_LABEL: Record<TunnelAccessMode, string> = { inherit: 'Inherit', custom: 'Allowed emails', public: 'Public' };
const MODES: TunnelAccessMode[] = ['inherit', 'custom', 'public'];
const SHOWN_RULES = 4;

/** The problem with an access list, worded for an inline error; null when it can be saved. */
export function tunnelRulesProblem(text: string, required: boolean): string | null {
  const { rules, invalid } = parseTunnelAccess(text);
  if (invalid.length) return `Not an email or *@domain rule: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? `, and ${invalid.length - 5} more` : ''}`;
  if (required && !rules.length) return 'Add at least one email, or choose Inherit or Public.';
  if (rules.length > MAX_TUNNEL_ALLOWED_EMAILS) return `At most ${MAX_TUNNEL_ALLOWED_EMAILS} rules.`;
  return null;
}

/** The mode an entry is saved with; entries from before modes existed read as custom when they have a list. */
export function savedTunnelMode(project: Pick<Project, 'tunnelAccessMode' | 'tunnelAllowedEmails'>): TunnelAccessMode {
  return project.tunnelAccessMode ?? (project.tunnelAllowedEmails?.length ? 'custom' : 'inherit');
}

function names(list: readonly string[]): string {
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

/** Project names as same-tab Manage links, or plain text while the draft has unsaved edits. */
function EntryLinks({ refs, linkable }: { refs: readonly TunnelAccessRef[]; linkable: boolean }) {
  return <>{refs.map((ref, index) => <Fragment key={ref.id}>
    {index > 0 && (index === refs.length - 1 ? ' and ' : ', ')}
    {linkable
      ? <a href={`#manage/project/${encodeURIComponent(ref.id)}`} title={`Open ${ref.name} in Manage`}>{ref.name}<ArrowUpRight size={11} weight="bold" aria-hidden="true" /></a>
      : <span>{ref.name}</span>}
  </Fragment>)}</>;
}

/** What Inherit would give this project, with where it comes from. */
function InheritedAccess({ access, linkable }: { access: TunnelAccess; linkable: boolean }) {
  const rules = access.allowedEmails;
  const shown = rules.length > SHOWN_RULES ? rules.slice(0, SHOWN_RULES - 1) : rules;
  const from = access.source === 'project' && access.from.length
    ? rules.length
      ? <>From <EntryLinks refs={access.from} linkable={linkable} />{access.from.length > 1 && ' (same folder, lists combined)'}</>
      : <>Set to Public on <EntryLinks refs={access.from} linkable={linkable} /></>
    : access.source === 'project' ? 'From a project folder above this one'
    : access.source === 'default' ? 'From the Settings default'
    : access.source === 'own' ? 'Set on this project'
    : 'No project folder above this one sets a list, and Settings has no default. Add one under Settings → Network.';
  return <div className="tunnel-access-inherited" title={rules.length ? rules.join('\n') : undefined}>
    {rules.length ? <LockSimple size={15} weight="bold" aria-hidden="true" /> : <GlobeSimple size={15} aria-hidden="true" />}
    <div>
      {rules.length
        ? <ul className="tunnel-access-rules" aria-label="Inherited allowed emails">
          {shown.map(rule => <li key={rule}>{rule}</li>)}
          {shown.length < rules.length && <li className="tunnel-access-more">+{rules.length - shown.length} more</li>}
        </ul>
        : <strong>Anyone with the link</strong>}
      <p className="tunnel-access-from">{from}</p>
    </div>
  </div>;
}

/**
 * Layered tunnel access for one project: inherit from its folder layers, its own allowed emails,
 * or explicitly public. A fieldset, because a label must not wrap the radios.
 */
export function TunnelAccessField({ project, mode, text, problem, dirty, textareaRef, onMode, onText, onBlur }: {
  project: Project;
  mode: TunnelAccessMode;
  text: string;
  /** Inline error to show now (after blur or a save attempt); null hides it. */
  problem: string | null;
  dirty: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  onMode: (mode: TunnelAccessMode) => void;
  onText: (text: string) => void;
  onBlur: () => void;
}) {
  const id = useId();
  const savedMode = savedTunnelMode(project);
  const inherited = project.tunnelAccessInherited ?? (savedMode === 'inherit' ? project.tunnelAccess : undefined);
  const peers = project.tunnelAccessPeers ?? [];
  const applies = <p className="field-hint">Applies to this project’s tunnels and to agent previews started in its folder. Projects in subfolders inherit it unless they set their own.</p>;
  return <fieldset className="field tunnel-access-field">
    <legend className="field-label">Tunnel access</legend>
    <div className="segmented tunnel-access-modes">
      {MODES.map(item => <label key={item}>
        <input className="sr-only" type="radio" name={`tunnel-mode-${id}`} value={item} checked={mode === item} onChange={() => onMode(item)} />
        <span>{MODE_LABEL[item]}</span>
      </label>)}
    </div>
    {mode === 'inherit' && <>{inherited ? <InheritedAccess access={inherited} linkable={!dirty} /> : <p className="field-hint">The server will resolve this from the project folders above it, then the Settings default.</p>}{applies}</>}
    {mode === 'custom' && <>
      <textarea ref={textareaRef} className="mono" aria-label="Allowed emails" rows={3} value={text} placeholder="you@example.com" spellCheck={false} autoCapitalize="none"
        aria-invalid={problem ? true : undefined} aria-describedby={`${problem ? `${id}-error ` : ''}${id}-hint`}
        onChange={event => onText(event.target.value)} onBlur={onBlur} />
      {problem && <p className="field-error" id={`${id}-error`}>{problem}</p>}
      <p className="field-hint" id={`${id}-hint`}>One per line; <code>*@example.com</code> allows a whole domain. Visitors confirm with a one-time PIN.</p>
      {applies}
    </>}
    {mode === 'public' && <div className="connection-notice tunnel-public-notice">Anyone with the link can open tunnels for this project, for subfolder projects that inherit, and for their agent previews.</div>}
    {peers.length > 0 && <p className="field-hint tunnel-access-peers">Shares its folder with {names(peers.map(peer => peer.name))}. Previews and subfolders there use {peers.length === 1 ? 'both entries’' : 'all of their'} lists combined.</p>}
  </fieldset>;
}
