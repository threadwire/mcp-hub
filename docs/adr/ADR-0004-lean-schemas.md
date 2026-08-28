# ADR-0004 — Lean tool schemas to protect context window

**Status:** accepted · **Date:** 2026-08

## Context
Discovery floods the agent context: 60+ verbose tool schemas, one
`tools/list` refresh per server per turn. OWASP MCP Top 10 calls out tool
discovery abuse as a DoS vector for the context window.

## Decision
The registry returns **lean schemas** (name, short description, trimmed input
schema) by default via the `plugin` transformer layer. Full fidelity is opt-in
per tenant. `cache.ts` applies `ttlMs` + `cacheScope` on aggregated discovery
to bound refresh cost.

## Consequences
- Smaller `tools/list` payloads, cheaper refreshes, lower context burn.
- Rich arguments still flow on `tools/call`; only discovery is slimmed.
- Plugin hook lets operators tune verbosity per upstream.