import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/router.js";
import { HubConfig } from "../src/types.js";
import { startFixture, stopFixture } from "./upstream.js";

const PORT = 8899;
let cfg: HubConfig;
let auditDir: string;

const HEADERS = { authorization: "Bearer mcp-hub-dev-token" };

before(async () => {
  await startFixture(PORT);
  auditDir = mkdtempSync(join(tmpdir(), "mcp-hub-audit-"));
  cfg = {
    bindHost: "127.0.0.1",
    port: PORT,
    servers: [
      {
        name: "fixture",
        url: `http://127.0.0.1:${PORT}`,
        scopes: ["read"],
        tools: [{ name: "fs.read" }, { name: "db.query" }],
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

function router(): Router {
  return new Router(cfg, join(auditDir, "audit.jsonl"));
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

test("rbac denies tool per tenant and records DENIED audit", async () => {
  const r = router();
  const out = (await call(
    r,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "db.query", arguments: {} } },
    { authorization: "Bearer restricted-token" },
  )) as any;
  assert.equal(out.error.code, 403);
  const lines = (await import("node:fs")).readFileSync(join(auditDir, "audit.jsonl"), "utf8").trim().split("\n");
  assert.ok(lines.some((l) => l.includes('"DENIED"') && l.includes("db.query")));
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
  const small = structuredClone(cfg);
  small.tenants[0].rate = { windowMs: 1000, limit: 2 };
  const r = new Router(small, join(auditDir, "rate.jsonl"));
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
  const lines = (await import("node:fs")).readFileSync(join(auditDir, "audit.jsonl"), "utf8").trim().split("\n");
  const hit = lines.filter((l) => l.includes("db.query") && l.includes('"OK"')).pop()!;
  assert.ok(!hit.includes("secrets"), "raw args must never reach the audit log");
  assert.match(hit, /inputHash/);
  assert.match(hit, /requestState/);
});