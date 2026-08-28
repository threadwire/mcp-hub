# Architecture — mcp-hub

A **stateless, single-endpoint MCP gateway**: every client speaks to one HTTP
endpoint; the hub terminates auth, enforces RBAC, rates, audits, and proxies
`tools/list` / `tools/call` JSON-RPC to a fleet of upstream Streamable HTTP
servers. No session store, no handshake, no client affinity.

```
 client ──POST /──▶ router ──▶ auth ──▶ rbac ──▶ rate ──▶ audit
                          │                              │
                          ▼                              ▼
                       registry ───────────▶ proxy ──▶ upstream MCP
                          │                    │
                          └─ cache ── TTL ─────┘ (requestState per call)
```

## Modules

| File             | Job                                                                 |
|------------------|---------------------------------------------------------------------|
| `router.ts`      | JSON-RPC 2.0 dispatch. Terminates MCP messages, **forwards `traceparent`** from inbound to upstream. |
| `auth.ts`        | Bearer → tenant; RFC 8707 resource indicator check; RFC 9207 `iss` validation. |
| `rbac.ts`        | Per-tenant allow/deny globs on `server.tool`; deny wins, least privilege. |
| `rate.ts`        | Sliding-window rate limit per tenant; `retryAfterMs` on 429. |
| `audit.ts`       | JSONL audit — who/what/input-hash/status/latency; raw args never logged. |
| `registry.ts`    | Server + tool catalog; aggregated `tools/list`; strict `s.tools ?? []` guard. |
| `cache.ts`       | `ttlMs` + `cacheScope` discovery cache per the 2026-07-28 spec. |
| `proxy.ts`       | Pure JSON-RPC 2.0 to upstream; `requestState` dedup key per call; `extraHeaders` injection for distributed traces. |
| `store.ts`       | SQLite (node:sqlite) — config, tenants, audit ring; defaults scopes to `[]`. |
| `discovery.ts`   | Boot-time `syncAll()` — pulls upstream tool lists, non-fatal on failure. |
| `oauth.ts`       | OAuth 2.0 Authorization Code + PKCE for upstreams. |
| `circuit.ts`     | Per-upstream circuit breaker (open/half-open/closed). |
| `plugin.ts`      | Transformer hook points around tool schemas. |
| `sse.ts` / `stdio.ts` | Upstream adapters (Server-Sent Events / child process). |
| `context.ts`     | Per-request context: tenant, deadline, trace identifiers. |
| `cli.ts`         | `mcp-hub init|add|doctor|start|audit`. |
| `server.ts` / `types.ts` | HTTP bootstrap + shared types. |

## Key invariants

1. **Stateless request path** — no session pinning; round-robin safe behind any
   load balancer, serverless-friendly.
2. **Trace propagation** — the hub is transparent to W3C `traceparent`: a
   client that already participates in a trace keeps it continuous through
   every upstream call. The sibling repo
   [`mcp-telemetry`](https://github.com/threadwire/mcp-telemetry) records the
   far side of the hop.
3. **Never binds 0.0.0.0** — default config binds `127.0.0.1` only.
4. **Audit by fingerprint** — input payloads are SHA-256 hashed, never stored
   or logged raw.
5. **Zero runtime deps** — pure Node 20+ (built-in `node:sqlite`, `node:test`,
   `node:http`). TypeScript compiled to `dist/` at publish time.

## Data flows

**tools/list** (cached):
`router → registry → [cache hit?] or discovery/upstream TTL refresh → response`

**tools/call** (uncached, stateful per call):
`router → auth → rbac → rate → audit → proxy → upstream → response (with requestState)`

## Conventions

- Errors are values, not exceptions; structured errors carry a dedup key.
- Side effects confined to `store.ts` and `audit.ts`; everything else pure-ish.
- Dependencies point one way (module graph is acyclic).