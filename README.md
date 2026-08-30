# mcp-hub

[![npm version](https://img.shields.io/npm/v/@threadwire/mcp-hub)](https://www.npmjs.com/package/@threadwire/mcp-hub)
[![License: MIT](https://img.shields.io/badge/license-MIT-brightgreen)](LICENSE)
[![runtime deps](https://img.shields.io/badge/runtime_deps-0-brightgreen)](#)

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
| `discovery`       | boot-time `syncAll()` — upstream tool-list pull, non-fatal on error |
| `store`           | SQLite config/tenants/audit via built-in `node:sqlite`              |
| `circuit`         | per-upstream circuit breaker (open / half-open / closed)            |
| `oauth` / `plugin` | OAuth PKCE upstream auth · schema transformer hooks                |

## Why it earns trust

- **Stateless** — round-robin behind any load balancer, serverless-friendly, no Redis session store.
- **Input-hashed audit** — OWASP's top MCP risk category ("Lack of Audit and Telemetry") closed by default; sensitive args are SHA-256 fingerprints, never payloads.
- **Never binds 0.0.0.0** — the June 2025 mass-exposure lesson is baked into the default config.
- **Structured errors with dedup keys** — a timed-out call can be retried with `requestState`; the gateway never lets an agent believe a tool ran when it didn't.
- **Zero runtime deps** — pure Node, one compiled binary worth of code.
- **Distributed traces built-in** — W3C `traceparent` is relayed verbatim through the gateway to every upstream; pair with [`mcp-telemetry`](https://github.com/threadwire/mcp-telemetry) for end-to-end spans.

## Observability

Point the hub at `mcp-trace` and every call lands in one live dashboard:

```json
{ "telemetryUrl": "http://127.0.0.1:8901", "telemetryToken": "trace-hub-secret" }
```

```bash
mcp-trace --serve 8901 --token trace-hub-secret &   # from mcp-telemetry
mcp-hub start                   # dashboard: http://127.0.0.1:8801/admin
```

`telemetryToken` is optional but recommended — the feed's `--serve` rejects
`/ingest` without a matching `--token` (or `MCP_TRACE_TOKEN`), and the hub
sends it as `Authorization: Bearer ...` on each span POST. When unset, spans
still flow to a feed running without a token.

The hub posts one span per `tools/call` outcome — OK, DENIED, RATE_LIMITED,
circuit-open, or upstream error — whose `traceId` and `parent_span_id` follow
the inbound W3C `traceparent`, so **client → hub → upstream** chains link end
to end in the dashboard. The bridge is fire-and-forget: a down telemetry feed
never slows a call. Audit rows are pruned after `auditRetentionMs` (default 30
days, `0` disables), and stale `tools/list` caches can be flushed with
`POST /cache/invalidate` (or automatically on `POST /admin/sync`).

## Docker

One command brings up the pair — gateway + telemetry, wired together:

```bash
docker compose up --build     # hub :8801 · dashboard :8901
```

- `mcp-hub/deploy/hub-config.json` is the config you edit (mounts read-write
  so `mcp-hub add` still works).
- Default `MCP_TRACE_TOKEN=trace-hub-secret` — override with an env var, and
  keep `hub-config.json`'s `telemetryToken` in sync.
- Both images run unprivileged; telemetry persists its feed to a volume at
  `/data`; hub's registry/audit lives at `/data` too.

## Use as a library

The gateway is plain classes — embed it without the CLI:

```js
import { HubServer, Router } from "@threadwire/mcp-hub";

// transport-agnostic core: attach handle() to any Node HTTP stack
const router = new Router(cfg, "/tmp/mcp-hub.db");
server.on("request", (req, res) => {
  backend(await router.handle(JSON.parse(body), req.headers), res);
});

// or the whole gateway, HTTP + admin + oauth included
await new HubServer(cfg, "/tmp/mcp-hub.db").listen(8801, "127.0.0.1");
```

Public surface: `HubServer`, `Router`, `HubStore`, `Discovery`, `Pipeline`,
`runStdioBridge`, `HUB_VERSION`, `PROTOCOL_VERSION`, plus all config/types.
`Router` owns zero I/O except its SQLite store and fetch calls — exact same
code paths the CLI runs. Full runnable example: `examples/embed.mjs`.

```bash
npm test    # unit + integration against an in-repo fixture upstream
mcp-hub audit --n 50   # tail the audit
```

MIT.
# I hope everyone will help develop MCP-HUB by submitting pull requests.
