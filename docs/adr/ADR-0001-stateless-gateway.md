# ADR-0001 — Stateless gateway, no session store

**Status:** accepted · **Date:** 2026-08

## Context
MCP's Streamable HTTP ships a handshake + session-pinning model that breaks
under round-robin load balancers and serverless. We want a gateway that scales
horizontally with zero coordination.

## Decision
The request path keeps no server-side session. Each JSON-RPC message is
self-contained; `requestState` dedup keys give agents an idempotent retry hook
without a session.

## Consequences
- Horizontal scaling is additive; no Redis, no sticky sessions.
- Upstreams still get their own sessions; the hub treats each call as one hop.
- Retry semantics move to the client via explicit `requestState`.