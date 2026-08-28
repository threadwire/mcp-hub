/**
 * JSON-RPC fuzzer: throws malformed envelopes at the router's handle() and
 * asserts the hub never throws NOR returns a non-JSON-RPC shape. Run standalone:
 *   node dist/tests/fuzz.mjs --rounds 2000
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../dist/src/router.js";

const rounds = Number(process.argv.indexOf("--rounds") >= 0 ? process.argv[process.argv.indexOf("--rounds") + 1] : "2000");

const cfg = {
  bindHost: "127.0.0.1",
  port: 1,
  servers: [
    {
      name: "seed",
      url: "http://127.0.0.1:1",
      scopes: ["read"],
      tools: [{ name: "db.query", inputSchema: { type: "object" } }],
    },
  ],
  tenants: [{ id: "dev", tokens: ["t"], allowTools: [], denyTools: [], rate: { windowMs: 60000, limit: 100000 }, expectedIss: null }],
};

let seed = 42;
function next() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed;
}

function payload() {
  const jsonrpc = ["2.0", "1.0", "2.1", "", 42, null, {}];
  const id = [undefined, null, 0, -1, 999, "abc", true, { a: 1 }];
  const method = ["tools/list", "tools/call", "tools/describe", "initialize", "ping", 42, null, void 0];
  const name = ["db.query", "nope", 42, null, void 0];
  const arguments_ = [undefined, {}, [], { sql: "SELECT 1" }, 42, null, "x"];
  const pick = (arr) => arr[next() % arr.length];
  const req = {
    jsonrpc: pick(jsonrpc),
    id: pick(id),
    method: pick(method),
    params: { name: pick(name), arguments: pick(arguments_) },
  };
  const kind = next() % 5;
  if (next() % 4 === 0) req.method = undefined;
  if (kind === 0) return 42;
  if (kind === 1) return "raw string";
  if (kind === 2) return null;
  if (kind === 3) return { jsonrpc: "2.0" };
  if (kind === 4) return req;
  return [req, req, 1];
}

const store = mkdtempSync(join(tmpdir(), "mcp-hub-fuzz-"));
let crashed = 0;
let protocolViolations = 0;

for (let i = 0; i < rounds; i++) {
  let out;
  try {
    out = await new Router(structuredClone(cfg), join(store, "f.db")).handle(payload(), { authorization: "Bearer t" });
  } catch (err) {
    crashed++;
    if (crashed < 4) console.error(`crash #${i}: ${err.message}`);
    continue;
  }
  const shape = (out && typeof out === "object" && (out.result !== undefined || out.error !== undefined)) ? true : false;
  if (!shape) protocolViolations++;
}

console.log(`fuzz: ${rounds} payloads`);
console.log(`crashes:            ${crashed}`);
console.log(`protocol violations: ${protocolViolations}`);
process.exit(crashed > 0 || protocolViolations > 0 ? 1 : 0);