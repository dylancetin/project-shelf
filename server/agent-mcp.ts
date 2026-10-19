import { timingSafeEqual, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Context } from 'hono';
import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentServers } from './agent-servers';
import { ApiError } from './errors';

export function mcpCredential(dbPath: string): string {
  // Isolated in-memory test apps do not create host credentials.
  if (dbPath === ':memory:') return randomBytes(32).toString('hex');
  const filename = path.resolve(`${dbPath}.mcp.json`);
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try { writeFileSync(filename, JSON.stringify({ bearerToken: randomBytes(32).toString('hex') }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  chmodSync(filename, 0o600);
  const config = JSON.parse(readFileSync(filename, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(config.bearerToken)) throw new Error(`Invalid MCP credential file: ${filename}`);
  return config.bearerToken;
}

export function authorizeMcp(request: Request, token: string, hostnames: string[]) {
  const target = new URL(request.url);
  const host = request.headers.get('host');
  if (host && host !== target.host) throw new ApiError(403, 'MCP Host header does not match the request address');
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]', 'panel.tail750ac6.ts.net', ...hostnames]);
  if (!allowed.has(target.hostname)) throw new ApiError(403, 'MCP Host is not a configured panel address');
  const origin = request.headers.get('origin');
  if (origin && origin !== target.origin) throw new ApiError(403, 'MCP Origin must match the panel address');
  if (['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site') ?? '')) throw new ApiError(403, 'Cross-origin MCP requests are forbidden');
  const supplied = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${token}`;
  if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new ApiError(401, 'MCP requires the local bearer credential');
}

export async function handleAgentMcp(c: Context, servers: AgentServers) {
  // A separate stateless server AND transport per request: two clients can use
  // the same JSON-RPC request ID without sharing pending-response maps.
  const server = new McpServer({ name: 'project-shelf-agent-servers', version: '1.0.0' });
  const result = async (operation: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
  };
  server.registerTool('add', {
    description: 'Start or reuse a manually retained development preview on this machine. Sets PORT=5000–5999 and replaces {port} in command. Use the actual worktree cwd. Does not append arguments. Returns ID, diagnostic PID, URL, separate runtime/readiness, and logs URL. Retry with the same idempotencyKey; do not launch unmanaged background processes.',
    inputSchema: { name: z.string().min(1).max(200), cwd: z.string().min(1).max(4096), command: z.string().min(1).max(16000), idempotencyKey: z.string().max(200).optional() },
  }, input => result(() => servers.add(input)));
  server.registerTool('delete', {
    description: 'Stop the entire owned agent-server unit/process tree, then remove its registration. Manual lifetime: only delete when asked or when this preview is no longer wanted. A failed stop retains the record. Repeated deletion is safe.',
    inputSchema: { id: z.string().uuid() },
  }, ({ id }) => result(() => servers.delete(id)));
  server.registerResource('agent-servers', 'shelf://agent-servers', { description: 'Current previews, readiness, URLs, IDs and log access', mimeType: 'application/json' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await servers.list()) }] }));
  server.registerResource('agent-server-logs', new ResourceTemplate('shelf://agent-servers/{id}/logs', { list: undefined }), { mimeType: 'text/plain', description: 'Last 150 journal lines (up to 64 KiB)' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: await servers.logs(String(variables.id)) }] }));
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(c) ?? new Response(null, { status: 202 }); }
  finally { await server.close(); }
}
