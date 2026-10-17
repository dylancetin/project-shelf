import type { SearchEngine } from './search';

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
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  runtime: { status: RunStatus; mode: RunMode | null; pid: number | null; startedAt: string | null; exitCode: number | null };
}
export interface Settings { roots: string[]; hostnames: string[]; defaultHostname: string; defaultSearchEngine: SearchEngine; lastScanAt: string | null }
export interface ScanResult { added: number; existing: number; scanned: number; errors: string[] }
export interface LogoFile { path: string; url: string }
export interface LogLine { id: number; timestamp: string; stream: 'stdout' | 'stderr' | 'system'; text: string }
