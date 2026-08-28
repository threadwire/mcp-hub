# mcp-hub

Gateway + registry for a fleet of MCP servers. **One endpoint, many servers, per-tenant RBAC, audit, rate limits.** Stateless per the 2026-07-28 spec.

```
┌──────────┐   POST /   ┌─────────┐   tools/list   ┌────────────────┐
│ Claude   │──────────▶ │ mcp-hub │ ─────────────▶ │ github-mcp     │
│ Cursor   │──────────▶ │ (router)│   tools/call   │ jira-mcp       │
│ any MCP  │──────────▶ │         │ ─────────────▶ │ db-tools       │
│ client   │  Bearer    └─────────┘                │ ... 10 servers │
└──────────┘  + RBAC                               └────────────────┘
```

The problem this kills: agents in production hold connections to 4-10 MCP servers with
separate auth, latencies and failure modes. Tool discovery becomes the bottleneck —
60+ tools flood the context window, one `tools/list` round-trip per server per refresh.
MCP broke 97M monthly SDK downloads with **no production playbook**; this is the playbook's first chapter.

## Install & run

```bash
npm install -g @threadwire/mcp-hub

mcp-hub init                       # ~/.mcp-hub/config.json (binds 127.0.0.1 only)
mcp-hub add github https://mcp.github.com --tools issues.create,pr.list --scopes read,write
mcp-hub add jira   https://mcp.atlassian.dev --tools issue.transition
mcp-hub doctor                     # health-check every upstream
mcp-hub start                      # http://127.0.0.1:8801
```

Point any MCP client at `http://127.0.0.1:8801` with `authorization: Bearer <tenant-token>`.

```bash
curl -s http://127.0.0.1:8801 \
  -H 'authorization: Bearer mcp-hub-dev-token' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"issues.create","arguments":{"title":"hello"}}}'
```

## What's inside

| Module            | Job                                                                 |
|-------------------|---------------------------------------------------------------------|
| `router`          | stateless JSON-RPC endpoint; no handshake, no session pinning       |
| `registry`        | server + tool catalog, aggregated `tools/list` with TTL cache       |
| `proxy`           | pure JSON-RPC 2.0 to upstream Streamable HTTP; `requestState` per call |
| `auth`            | Bearer → tenant; RFC 8707 resource check; RFC 9207 `iss` validation |
| `rbac`            | per-tenant allow/deny globs — least privilege, deny wins            |
| `rate`            | sliding window per tenant; `retryAfterMs` on 429                   |
| `audit`           | JSONL audit: who/what/input-hash/status/latency — raw args never logged |
| `cache`           | `ttlMs` + `cacheScope` discovery cache per the 2026-07-28 spec     |

## Why it earns trust

- **Stateless** — round-robin behind any load balancer, serverless-friendly, no Redis session store.
- **Input-hashed audit** — OWASP's top MCP risk category ("Lack of Audit and Telemetry") closed by default; sensitive args are SHA-256 fingerprints, never payloads.
- **Never binds 0.0.0.0** — the June 2025 mass-exposure lesson is baked into the default config.
- **Structured errors with dedup keys** — a timed-out call can be retried with `requestState`; the gateway never lets an agent believe a tool ran when it didn't.
- **Zero runtime deps** — pure Node, one compiled binary worth of code.

MIT.

```bash
npm test    # unit + integration against an in-repo fixture upstream
mcp-hub audit --n 50   # tail the audit
```