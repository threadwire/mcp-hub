# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/), versions follow semver.

## [Unreleased]

### Added
- **Gateway as a library** — `src/index.ts` is the public surface (`HubServer`,
  `Router`, `HubStore`, `Discovery`, `Pipeline`, `runStdioBridge`,
  `HUB_VERSION`, `PROTOCOL_VERSION`); `package.json` declares `main`/`types`/
  `exports` so embedding is a named import, with `examples/embed.mjs` as a
  runnable reference. Declarations are emitted (`declaration: true`) and the
  runtime now requires Node `>=22.13`.
- **Docker** — multi-stage `Dockerfile` (compile stage, then a toolchain-free
  scratch image running as `node`), plus a root `docker-compose.yml` that
  brings up hub + telemetry pre-wired, and `deploy/hub-config.json` as the
  mounted config.
- **Telemetry auth pairing** — `telemetryToken` in config; span POSTs carry
  `Authorization: Bearer <token>` so a token-protected feed accepts them.

## [0.3.0-beta.1] - 2026-08-29

First public beta: the release pipeline is real, the metrics are honest, and
the hub bridges into `mcp-telemetry` as the front half of a full tracing story.

### Added
- **Telemetry bridge** — optional `telemetryUrl` in config.json; every
  `tools/call` outcome (OK / DENIED / RATE_LIMITED / upstream error / circuit
  open / unknown tool) posts a fire-and-forget span to `<url>/ingest`, reusing
  the inbound W3C `traceparent` so client → hub → upstream chains link into an
  `mcp-trace` dashboard. Down bridge never affects the request path.
- **Audit retention** — audit rows are pruned past `auditRetentionMs`
  (default 30 days, `0` disables) at boot and hourly.

### Fixed
- `POST /cache/invalidate` was a no-op returning `{ok:true}` — it now actually
  flushes the tools/list cache (admin-guarded, `?server=` for one upstream);
  `POST /admin/sync` flushes the cache automatically after discovery.
- `initialize` reported `serverInfo.version: "0.1.0"` — now reads the real
  version from package.json, everywhere (`initialize`, `mcp-hub version`).
- `allServers()` replaced an N+1 per-server SQL load with one bulk query.
- `auditSummary()` replaced the `avg * 1.8` p95 heuristic with real
  p50/p95/p99 percentiles over the actual latency sample.
- Sync `package-lock.json` version with package.json (was stale at 0.1.0).

### Changed
- Registry + cache read paths reworked to stay O(servers) per request.

## [0.2.1] - 2026-08-20

### Added
- `mcp-hub rm <name>`, `/metrics` with Prometheus text format.
- `start --port / --host` flags.
- HTTP-level integration tests against an in-repo fixture upstream.

[0.3.0-beta.1]: https://github.com/threadwire/mcp-hub/compare/v0.2.1...v0.3.0-beta.1
[0.2.1]: https://github.com/threadwire/mcp-hub/compare/v0.2.0...v0.2.1