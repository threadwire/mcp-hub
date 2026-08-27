/**
 * Tiny Streamable-HTTP MCP upstream used by the test suite.
 * Plain Node, no MCP SDK — proves the hub talks pure JSON-RPC to anything.
 */
import { createServer } from "node:http";

const TOOLS = [
  {
    name: "fs.read",
    description: "read a file (path)",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "db.query",
    description: "run a SQL query",
    inputSchema: { type: "object", properties: { sql: { type: "string" } } },
  },
];

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/mcp") {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("{}");
      return;
    }
    const id = parsed.id ?? null;
    let out: any = { jsonrpc: "2.0", id, error: { code: -32601, message: "noop" } };
    if (parsed.method === "ping") {
      out = { jsonrpc: "2.0", id, result: {} };
    } else if (parsed.method === "tools/list") {
      out = { jsonrpc: "2.0", id, result: { tools: TOOLS, ttlMs: 60_000 } };
    } else if (parsed.method === "tools/call") {
      const name = parsed.params?.name;
      if (name === "fs.read" && parsed.params?.arguments?.path === "boom") {
        out = {
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "ENOENT: no such file", data: { requestState: parsed.params?.requestState } },
        };
      } else {
        out = {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `${name} -> ${JSON.stringify(parsed.params?.arguments ?? {})}` }],
          },
        };
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
});

export function startFixture(port: number): Promise<void> {
  return new Promise((resolvePromise) => {
    server.listen(port, "127.0.0.1", () => resolvePromise());
  });
}

export function stopFixture(): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

if (process.argv[1] && process.argv[1].endsWith("upstream.js")) {
  const port = Number(process.argv[2] ?? 8899);
  startFixture(port).then(() => console.log(`fixture upstream on :${port}`));
}