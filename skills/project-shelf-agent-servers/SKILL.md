---
name: project-shelf-agent-servers
description: Required workflow for background development previews on beelinkk. Start retained preview servers through Project Shelf MCP, never unmanaged background launches.
---

# Agent development previews

Agents **MUST use this MCP** whenever starting a background development server or web preview for a user on beelinkk, including worktrees. Do not use `nohup`, detached shell jobs, ad-hoc `systemd-run`, or an unmanaged background tool launch for this workflow. Existing Project Shelf registered projects retain their normal lifecycle; this skill covers agent-created previews.

## Local connection (no CLI)

- Streamable HTTP MCP endpoint: `http://127.0.0.1:4958/mcp` on beelinkk. Remote trusted clients may use `http://beelinkk:4958/mcp`; use a trusted LAN/Tailscale or TLS proxy, since bearer tokens over ordinary HTTP are not encrypted.
- Persisted local credential: `/home/taytay/.t3-nightly/projects/dev-server-panel/data/panel.sqlite.mcp.json`, field `bearerToken`. It is created automatically, mode `0600`, ignored by Git. Read it locally; never print it in chat, logs, committed files, or screenshots.
- Configure your MCP client's HTTP transport with header `Authorization: Bearer <locally-read bearerToken>`. Configure secrets in an ignored local configuration or client-supported environment interpolation, not source control. Do not send a browser cross-origin `Origin` header. Host must be a configured panel hostname or loopback.
- For **OpenCode V2**, merge this into the relevant project `opencode.jsonc` without replacing unrelated settings (or configure it yourself globally if you explicitly want every project). This is a remote HTTP MCP server, **not** a local command, and OAuth must be disabled:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "project-shelf": {
        "type": "remote",
        "url": "http://127.0.0.1:4958/mcp",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:PROJECT_SHELF_MCP_TOKEN}" }
      }
    }
  }
}
```

Load the secret into the environment of the process actually hosting the MCP client. For a locally launched client on beelinkk, this shell setup captures the JSON field without showing the token or placing it in shell history; keep tracing disabled:

```sh
set +x
export PROJECT_SHELF_MCP_TOKEN="$(bun -e 'const c = await Bun.file("/home/taytay/.t3-nightly/projects/dev-server-panel/data/panel.sqlite.mcp.json").json(); process.stdout.write(c.bearerToken)')"
```

Start the client from that environment. A pre-existing shared OpenCode service does **not** inherit new terminal environment variables: supply the same secret through that service's existing environment/secret configuration and reconnect the MCP. Do not modify or restart unrelated global services automatically. Use OpenCode's `/mcps` interface to confirm `project-shelf` is connected and that `add`/`delete` are available. Other MCP clients should use their documented HTTP server/header configuration with the same credential. No Project Shelf CLI is installed or required.

The endpoint is stateless: each request gets an independent MCP server/transport. No accounts, OAuth, or CLI is required. A `401` means the configured bearer credential is missing/wrong; a `403` means Host/Origin is not allowed.

## Start or reuse

Call MCP tool **`add`** with `name`, absolute `cwd`, and foreground `command`. Use the **actual worktree directory**, not the main checkout. Include a unique `idempotencyKey` for the intended preview and retain it for retries. Reusing a key with different inputs is rejected; identical inputs without a key also deduplicate. A deleted request cannot be resurrected by a delayed retry: use a new key for an intentionally new run.

```json
{
  "name": "My feature preview",
  "cwd": "/absolute/path/to/the/worktree",
  "command": "./node_modules/.bin/vite --port {port} --strictPort --host 0.0.0.0",
  "idempotencyKey": "feature-unique-run-1"
}
```

**PORT caveat:** the panel chooses a free random port from `5000–5999`, sets `PORT`, and replaces explicit `{port}` placeholders. Some tools (notably Vite) ignore `PORT`. Use `bunx vite --port {port} --strictPort --host 0.0.0.0` or the equivalent installed Vite command. The panel never blindly appends flags. Bind to `0.0.0.0` for user reachability and do not override the assigned port or enable automatic port fallback. Do not put secrets in `command` (it is shown in the panel). The child gets only a minimal allowlisted environment, not panel credentials or API keys; load any needed project-specific development configuration deliberately.

The result includes stable `id`, `machineId`, machine name, diagnostic-only `pid`, assigned `port`, preferred-hostname `url`, actual runtime `status`, separate `ready`, and `logsUrl`. The “Original hostname” preference uses the persisted local machine hostname when the preference is empty. A running process is not necessarily ready. Readiness requires HTTP and ownership of the IPv4 wildcard listener (`0.0.0.0`); an IPv6-only listener cannot certify the IPv4 HTTP probe. If not ready, inspect logs, fix configuration, and explicitly delete/recreate with a new key if needed. Never kill a port occupant. PID is diagnostic only and cannot be registered or used as an ownership token.

## Inspect and retain

- MCP resource `shelf://agent-servers` lists current records and statuses.
- MCP resource `shelf://agent-servers/<id>/logs` reads recent journal logs (last 150 lines, at most 64 KiB). Same-origin UI uses `/api/agent-servers` and `/api/agent-servers/<id>/logs`.
- Home displays Agent Servers **beneath Projects in the same column**, including the browser extension. Visit opens the preferred URL; Logs exposes command, worktree, PID, status, and output; Stop stops and removes the run.
- **Leave the server running for manual user verification. Return the reachable URL to the user.** There is no TTL. Panel restart does not stop these independent user-systemd units. Machine reboot does stop them; persistent records remain inspectable and can be removed. No remote execution is implemented.

## Stop and delete

When the user requests cleanup or a preview is intentionally retired, call MCP tool **`delete`** with `{ "id": "<server-generated ID>" }`. It stops the entire owned systemd control group and only then removes registration. A failed stop keeps the row visible for recovery; retry rather than hiding it. Repeated delete is safe. Do not target arbitrary PIDs or systemd units.

## Installation

Repository source: `/home/taytay/.t3-nightly/projects/dev-server-panel/skills/project-shelf-agent-servers/SKILL.md`.
Installed symlink: `/home/taytay/.agents/skills/project-shelf-agent-servers` → the repository skill directory. No global MCP configuration is modified automatically.
