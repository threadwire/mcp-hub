/**
 * Load test against a live hub. Usage:
 *   node dist/tests/load.mjs --url http://127.0.0.1:8801/mcp --token <t> --calls 500 --concurrency 25
 *
 * Mix: tools/list (cached, cheap) + tools/call (touch upstream). Reports p50/p95
 * latency and error rate. Exit 1 if error rate > 1% — sane gate for CI smoke.
 */
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const url = flag("--url") ?? "http://127.0.0.1:8801/mcp";
const token = flag("--token") ?? "mcp-hub-dev-token";
const calls = Number(flag("--calls") ?? "500");
const concurrency = Number(flag("--concurrency") ?? "25");

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
};

async function one(i) {
  const t0 = performance.now();
  const body =
    i % 10 === 0
      ? { jsonrpc: "2.0", id: i, method: "tools/list", params: {} }
      : { jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "db.query", arguments: { sql: "SELECT 1" } } };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { ms: performance.now() - t0, ok: res.status < 300 && !text.includes('"error":') };
}

async function main() {
  console.log(`load: ${calls} calls, c=${concurrency}, url=${url}`);
  const t0 = performance.now();
  const results = [];
  const queue = Array.from({ length: Math.min(calls, concurrency) }, async () => {
    while (true) {
      const next = results.length;
      if (next >= calls) return;
      results.push(null);
      results[next] = await one(next);
    }
  });
  await Promise.all(queue);
  const elapsed = performance.now() - t0;
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const errors = results.filter((r) => !r.ok).length;
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor((q / 100) * lat.length))];
  const rate = (errors / results.length) * 100;
  console.log(`completed: ${results.length} in ${(elapsed / 1000).toFixed(2)}s`);
  console.log(`req/s:     ${Math.round(results.length / (elapsed / 1000))}`);
  console.log(`p50:       ${p(50).toFixed(2)}ms   p95: ${p(95).toFixed(2)}ms   p99: ${p(99).toFixed(2)}ms`);
  console.log(`errors:    ${errors} (${rate.toFixed(2)}%)`);
  process.exit(rate > 1 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});