import type { SearchEngine } from './search';
import type { TunnelAccess, TunnelAccessMode, TunnelAccessRef, TunnelState } from './tunnels';

export type ProjectKind = 'project' | 'service';
export type RunMode = 'dev' | 'prod' | 'build';
// Unknown is a client-only state for saved entries while the server is unreachable.
export type RunStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed' | 'unknown';
export interface Project {
  id: string;
  name: string;
  description: string;
  kind: ProjectKind;
  directory: string;
  source: string;
  url: string;
  hostname: string;
  devCommand: string;
  buildCommand: string;
  prodCommand: string;
  port: number | null;
  logo: string; // Empty (automatic), project-relative image path, or HTTP(S) image URL.
  favorite: boolean;
  /**
   * Layered tunnel access (see `TunnelAccessMode`). Stored entries without a mode read as
   * `custom` when they have a non-empty list, else `inherit`. Absent on older clients' entries.
   */
  tunnelAccessMode?: TunnelAccessMode;
  /** The project's own Cloudflare Access list (emails or `*@domain`); non-empty only when the mode is `custom`. */
  tunnelAllowedEmails?: string[];
  /** Server-computed, read-only (ignored on PATCH): effective access right now. Absent for services. */
  tunnelAccess?: TunnelAccess;
  /** Server-computed, read-only: what `inherit` would give this project (excluding its own list). Absent for services. */
  tunnelAccessInherited?: TunnelAccess;
  /** Server-computed, read-only: other project entries registered at the exact same directory. */
  tunnelAccessPeers?: TunnelAccessRef[];
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  runtime: { status: RunStatus; mode: RunMode | null; pid: number | null; startedAt: string | null; exitCode: number | null; tunnel?: TunnelState | null };
}
export interface Settings {
  roots: string[]; hostnames: string[]; defaultHostname: string; defaultSearchEngine: SearchEngine; lastScanAt: string | null;
  /** Default tunnel access for projects and agent previews that get no list from their folder layers. Empty: anyone with the link. Absent on older databases (read as empty). */
  tunnelAllowedEmails?: string[];
}
export interface ScanResult { added: number; existing: number; scanned: number; errors: string[] }
export interface LogoFile { path: string; url: string }
export interface LogLine { id: number; timestamp: string; stream: 'stdout' | 'stderr' | 'system'; text: string }
