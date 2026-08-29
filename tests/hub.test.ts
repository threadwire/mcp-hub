import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { Router } from "../src/router.js";
import { HubServer } from "../src/server.js";
import { HubConfig } from "../src/types.js";
import { HubStore } from "../src/store.js";
import { Discovery } from "../src/discovery.js";
import { CircuitBreaker } from "../src/circuit.js";
import { OAuthProvider } from "../src/oauth.js";
import { Pipeline, RedactPlugin, ApprovalPlugin } from "../src/plugin.js";
import { leanView, fullView, contextSavings } from "../src/context.js";
import { wantsSse } from "../src/sse.js";
import { runStdioBridge } from "../src/stdio.js";
import { startFixture, stopFixture } from "./upstream.js";

const PORT = 8899;
let cfg: HubConfig;
let tmp: string;

const HEADERS = { authorization: "Bearer mcp-hub-dev-token" };

before(async () => {
  await startFixture(PORT);
  tmp = mkdtempSync(join(tmpdir(), "mcp-hub-tests-"));
  cfg = {
    bindHost: "127.0.0.1",
    port: PORT,
    servers: [
      {
        name: "fixture",
        url: `http://127.0.0.1:${PORT}`,
        scopes: ["read"],
        tools: [
          {
            name: "fs.read",
            inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
          {
            name: "db.query",
            description: "run a read-only sql query",
            inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
          },
        ],
      },
    ],
    tenants: [
      {
        id: "dev",
        tokens: ["mcp-hub-dev-token"],
        allowTools: [],
        denyTools: [],
        rate: { windowMs: 60_000, limit: 1000 },
        expectedIss: null,
      },
      {
        id: "restricted",
        tokens: ["restricted-token"],
        allowTools: ["fs.*"],
        denyTools: ["fs.write"],
        rate: { windowMs: 60_000, limit: 1000 },
        expectedIss: null,
      },
    ],
  };
});

after(async () => {
  await stopFixture();
});

function router(mut: (c: HubConfig) => void = () => {}): Router {
  const c = structuredClone(cfg);
  mut(c);
  return new Router(c, join(tmp, `r-${Math.random().toString(36).slice(2)}.db`));
}

const call = (
  r: Router,
  m: unknown,
  headers: Record<string, string | string[] | undefined> = HEADERS,
) => r.handle(m, headers);

test("initialize is stateless and returns the 2026-07-28 protocol version", async () => {
  const r = router();
  const out = (await call(r, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as any;
  assert.equal(out.result.protocolVersion, "2026-07-28");
  assert.equal(out.result.serverInfo.name, "mcp-hub");
  assert.ok(!("sessionId" in out.result));
});

test("tools/list aggregates fleet and honors tenant allowlist", async () => {
  const r = router();
  const out = (await call(r, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as any;
  assert.equal(out.result.tools.length, 2);
  assert.deepEqual(
    out.result.tools.map((t: any) => t.name).sort(),
    ["db.query", "fs.read"],
  );

  const restricted = (await call(
    r,
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { authorization: "Bearer restricted-token" },
  )) as any;
  assert.deepEqual(restricted.result.tools.map((t: any) => t.name), ["fs.read"]);
});

test("tools/list is LEAN: no schemas, savings math attached", async () => {
  const r = router();
  const out = (await call(r, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as any;
  for (const t of out.result.tools) {
    assert.equal(t.lean, true);
    assert.equal(t.inputSchema, undefined, "lean skeletons must not carry schemas");
    assert.ok(t.hint.length <= 49);
    assert.ok(Array.isArray(t.required));
  }
  assert.ok(out.result.meta.tokenBudget.savedBytes > 0, "savings must be nonzero");
  assert.match(out.result.meta.protocolHint, /tools\/describe/);
});

test("tools/describe returns the FULL schema for one named tool", async () => {
  const r = router();
  const out = (await call(r, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/describe",
    params: { name: "db.query" },
  })) as any;
  assert.equal(out.error, undefined);
  assert.ok(out.result.inputSchema, "describe must include the full schema");
  assert.ok(out.result.inputSchema.properties, "schema must include properties");
  assert.equal(out.result.lean, true);
});

test("tools/describe unknown tool -> -32602", async () => {
  const r = router();
  const out = (await call(r, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/describe",
    params: { name: "ghost" },
  })) as any;
  assert.equal(out.error.code, -32602);
});

test("tools/call proxies through and returns requestState", async () => {
  const r = router();
  const out = (await call(r, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "db.query", arguments: { sql: "SELECT 1" } },
  })) as any;
  assert.equal(out.error, undefined);
  assert.ok(out.result.requestState);
  assert.match(out.result.content[0].text, /db\.query/);
});

test("tools/call forwards the W3C traceparent header to the upstream", async () => {
  const r = router();
  const orig = globalThis.fetch;
  let upstreamHeaders: Record<string, string> = {};
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    upstreamHeaders = Object.fromEntries(new Headers(init?.headers).entries());
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const out = (await call(
      r,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "db.query", arguments: {} } },
      { ...HEADERS, traceparent: "00-aa11bb22cc33dd44ee55ff6677889900-1122334455667788-01" },
    )) as any;
    assert.equal(out.error, undefined);
    assert.equal(upstreamHeaders["traceparent"], "00-aa11bb22cc33dd44ee55ff6677889900-1122334455667788-01");
  } finally {
    globalThis.fetch = orig;
  }
});

test("tools/call surfaces upstream error in structured JSON-RPC error", async () => {
  const r = router();
  const out = (await call(r, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "fs.read", arguments: { path: "boom" } },
  })) as any;
  assert.equal(out.error.code, -32603);
  assert.equal(out.error.message, "ENOENT: no such file");
  assert.ok(out.error.data.retryable);
});

test("circuit breaker opens after threshold and reports retryAfterMs", async () => {
  const b = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 });
  assert.ok(!b.isOpen);
  b.onFailure();
  b.onFailure();
  b.onFailure();
  assert.ok(b.isOpen);
  assert.ok(b.retryAfterMs() > 0);
  assert.equal(b.snapshot().state, "open");
});

test("rbac denies tool per tenant and records DENIED audit in sqlite", async () => {
  const r = router();
  const out = (await call(
    r,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "db.query", arguments: {} } },
    { authorization: "Bearer restricted-token" },
  )) as any;
  assert.equal(out.error.code, 403);
  const entries = r.auditQuery({});
  assert.ok(entries.some((e) => e.status === "DENIED" && e.tool === "db.query"));
});

test("unknown tool returns -32602", async () => {
  const r = router();
  const out = (await call(r, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "nope.missing", arguments: {} },
  })) as any;
  assert.equal(out.error.code, -32602);
});

test("unauthorized request without token is rejected", async () => {
  const r = router();
  const out = (await call(r, { jsonrpc: "2.0", id: 1, method: "ping", params: {} }, {})) as any;
  assert.equal(out.error.code, 401);
});

test("rate limiter trips and returns retryAfterMs", async () => {
  const r = router((c) => {
    c.tenants[0].rate = { windowMs: 1000, limit: 2 };
  });
  for (let i = 0; i < 2; i++) {
    const ok = (await call(r, {
      jsonrpc: "2.0",
      id: i,
      method: "tools/call",
      params: { name: "db.query", arguments: { sql: "SELECT 1" } },
    })) as any;
    assert.equal(ok.error, undefined);
  }
  const denied = (await call(r, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "db.query", arguments: {} },
  })) as any;
  assert.equal(denied.error.code, 429);
  assert.ok(denied.error.data.retryAfterMs >= 0);
});

test("tools/list is cached across calls within TTL", async () => {
  const r = router();
  const a = (await call(r, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as any;
  const b = (await call(r, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })) as any;
  assert.deepEqual(a.result, b.result);
});

test("audit records OK invoke with input hash, never raw args", async () => {
  const r = router();
  await call(r, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "db.query", arguments: { sql: "SELECT * FROM secrets" } },
  });
  const hit = r.auditQuery({ tool: "db.query" }).filter((e) => e.status === "OK")[0];
  assert.ok(hit, "OK audit row exists");
  assert.match(hit.inputHash, /^[0-9a-f]{16}$/);
  assert.ok(hit.requestState);
  assert.ok(!JSON.stringify(hit).includes("secrets"), "raw args must never reach the audit store");
});

test("queryAudit supports tool+tenant+since filters", async () => {
  const store = new HubStore(join(tmp, "q.db"));
  store.audit({ tenant: "a", tool: "t1", server: "s", status: "OK", latencyMs: 3, inputHash: "h" });
  store.audit({ tenant: "b", tool: "t2", server: "s", status: "ERROR", latencyMs: 9, inputHash: "h", error: "boom" });
  assert.equal(store.queryAudit({ tenant: "a" }).length, 1);
  assert.equal(store.queryAudit({ tool: "t2" })[0].error, "boom");
  assert.equal(store.queryAudit({ status: "OK" }).length, 1);
});

test("discovery pulls real tools/list from upstream into the store", async () => {
  const store = new HubStore(join(tmp, `disco-${Date.now()}.db`));
  const d = new Discovery(store, cfg);
  const reports = await d.syncAll();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].ok, true);
  assert.ok(reports[0].toolsFound >= 2, "discovered real upstream tools");
  const stored = store.allServers();
  assert.equal(stored[0].name, "fixture");
  assert.ok(stored[0].tools.length >= 2);
});

test("oauth PKCE flow mints a bearer token", async () => {
  const provider = new OAuthProvider(cfg);
  provider.registerClient("client-dev", null);
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = provider.authorize({
    response_type: "code",
    client_id: "client-dev",
    redirect_uri: "https://app.example/cb",
    code_challenge: challenge,
  });
  assert.ok("code" in code);
  const tok = provider.token({
    grant_type: "authorization_code",
    code: (code as { code: string }).code,
    code_verifier: verifier,
  });
  assert.ok("access_token" in tok);
  const validated = provider.validate((tok as any).access_token);
  assert.equal(validated?.tenantId, "dev");
});

test("plugin redaction scrubs secrets before upstream + audit", async () => {
  const r = router((c) => {
    c.plugins = [RedactPlugin([/token|secret/i])];
  });
  const out = (await call(r, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "db.query", arguments: { sql: "SELECT 1", secret: "s3cr3t" } },
  })) as any;
  assert.equal(out.error, undefined);
  assert.ok(!JSON.stringify(r.auditQuery({ tool: "db.query" })).includes("s3cr3t"));
});

test("approval plugin vetoes gated tools", async () => {
  const r = router((c) => {
    c.plugins = [ApprovalPlugin({ require: /db\./, gate: () => false })];
  });
  const out = (await call(r, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "db.query", arguments: {} },
  })) as any;
  assert.equal(out.error.code, -32603);
  assert.match(out.error.message, /manual approval/);
});

test("context helpers compute honest byte savings", () => {
  const tool = { name: "db.query", description: "run sql safely", inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } };
  const lean = leanView(tool, 1000);
  const full = fullView(tool, 1000);
  const s = contextSavings({ tools: [lean] }, { tools: [full] });
  assert.ok(s.savedBytes > 0);
  assert.ok(s.fullBytes > s.leanBytes);
});

test("sse negotiation detects text/event-stream", () => {
  assert.ok(wantsSse({ headers: { accept: "text/event-stream" } } as any));
  assert.ok(!wantsSse({ headers: { accept: "application/json" } } as any));
});

test("stdio bridge unwraps SSE frames to line-delimited JSON-RPC", async () => {
  const out = new Writable();
  let stdoutData = "";
  out._write = (chunk, _enc, cb) => {
    stdoutData += chunk.toString();
    cb();
  };
  const input = Readable.from([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n",
  ]);
  await runStdioBridge({
    url: `http://127.0.0.1:${PORT}/mcp`,
    token: "mcp-hub-dev-token",
    input: input as any,
    output: out as any,
  });
  const line = stdoutData.trim();
  const parsed = JSON.parse(line);
  assert.equal(parsed.jsonrpc, "2.0");
  assert.equal(parsed.id, 1);
});

test("http /metrics exposes Prometheus text counters after a proxied call", async () => {
  const c = structuredClone(cfg);
  c.port = 8911;
  const server = new HubServer(c, join(tmp, `metrics-${Math.random().toString(36).slice(2)}.db`));
  await server.listen();
  try {
    const call = await fetch(`http://127.0.0.1:8911/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer mcp-hub-dev-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "db.query", arguments: { sql: "select 1" } } }),
    });
    assert.equal(call.status, 200);
    const metrics = await (await fetch(`http://127.0.0.1:8911/metrics?format=prometheus`)).text();
    assert.match(metrics, /mcp_hub_calls_total{tool="db\.query"} 1/);
    assert.match(metrics, /mcp_hub_errors_total 0/);
  } finally {
    await server.close();
  }
});