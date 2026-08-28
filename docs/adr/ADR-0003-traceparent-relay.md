# ADR-0003 — Traceparent passthrough at the router

**Status:** accepted · **Date:** 2026-08

## Context
Production fleets want one trace from the agent down through every upstream
tool. The gateway is a natural propagation point: it sees inbound headers and
controls outbound calls. Without it, each hop starts a fresh trace and debugging
a multi-server `tools/call` is archaeology.

## Decision
`router.ts` reads the inbound `traceparent` header on `tools/call`; `proxy.ts`
takes `extraHeaders` and forwards it verbatim upstream. No trace manipulation —
the hub is a transparent W3C `traceparent` relay. The sibling repo
[mcp-telemetry](../README.md#distributed-tracing) records the far side
(`parent_span_id` links the gateway hop to the upstream span).

## Consequences
- End-to-end traces continue across the hub boundary.
- Telemetry built from the far side can replay the joined trace offline
  (`mcp-trace --replay`).
- Header must be validated defensively (malformed values are dropped).
- Verified live: client header `00-4df7…-2a1b…-01` reached the upstream span
  with the same trace id and the parent span id preserved.