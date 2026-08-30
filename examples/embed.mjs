// mcp-hub embedded as a library — no CLI, your own HTTP transport.
//
// Two ways in:
//   1. HubServer — the whole gateway (HTTP, admin, oauth) in one class.
//   2. Router     — transport-agnostic JSON-RPC core; mount handle() on any
//                   Node HTTP stack you already own.
//
// Run:  npm run build && node examples/embed.mjs
import { HUB_VERSION, Router } from "../dist/src/index.js";
import { createServer } from "node:http";

const cfg = {
  bindHost: "127.0.0.1",
  port: 8801,
  servers: [
    // A real Streamable HTTP upstream, or leave empty and programmatically
    // register later — this example only checks initialize/tools/list shape.
    { name: "calendar", url: "http://127.0.0.1:9001/mcp", scopes: ["read"], tools: [] },
  ],
  tenants: [
    {
      id: "dev",
      tokens: ["dev-token"],
      allowTools: [],
      denyTools: [],
      rate: { windowMs: 60_000, limit: 120 },
      expectedIss: null,
    },
  ],
  adminToken: "dev-token",
  telemetryUrl: "http://127.0.0.1:8901", // optional mcp-trace bridge
};

const router = new Router(cfg, "/tmp/mcp-hub-embed.db");

const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const envelope = JSON.parse(body || "{}");
    const out = await router.handle(envelope, req.headers);
    const status = out.error ? out.error.code : 200;
    res.writeHead(status >= 400 ? status : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(err) } }));
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  router.close();
  server.close(() => process.exit(0));
});

server.listen(cfg.port, cfg.bindHost, () => {
  console.log(`embedded mcp-hub v${HUB_VERSION} on http://${cfg.bindHost}:${cfg.port}`);
  console.log(`try: curl -s :8801 -H 'authorization: Bearer dev-token' -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'`);
});