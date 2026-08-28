# ADR-0002 — SQLite for registry, tenants, audit

**Status:** accepted · **Date:** 2026-08

## Context
We need durable config (servers, tenants, RBAC) plus an append-only audit
trail. A full DB server is overkill for a single-node tool.

## Decision
Use Node's built-in `node:sqlite` (zero runtime deps). Config tables for
servers/tenants/scopes; audit as an append-only table with a bounded retention
ring. Schema evolved — `saveServer` writes scopes via `scopes ?? []` to keep
older rows valid.

## Consequences
- Zero deps, synchronous, fast enough for audit at gateway scale.
- Single-writer assumption; horizontal replicas share nothing (matches ADR-0001).
- Migration discipline required on column changes.