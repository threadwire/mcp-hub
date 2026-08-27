import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Router } from "./router.js";
import { HubConfig } from "./types.js";

/**
 * Stateless Streamable HTTP endpoint per the 2026-07-28 spec: any container can
 * serve any request, round-robin friendly, no session pinning, no Redis.
 * Binds to loopback by default — never 0.0.0.0 unless you mean it.
 */
export class HubServer {
  private router: Router;
  private started = Date.now();

  constructor(private cfg: HubConfig, auditPath: string) {
    this.router = new Router(cfg, auditPath);
  }

  async listen(): Promise<void> {
    const srv = createServer((req, res) => this.route(req, res));
    srv.listen(this.cfg.port, this.cfg.bindHost, () => {
      console.log(
        `mcp-hub listening on http://${this.cfg.bindHost}:${this.cfg.port} ` +
          `(servers=${this.cfg.servers.length} tools=${this.cfg.servers.reduce((a, s) => a + s.tools.length, 0)} tenants=${this.cfg.tenants.length})`,
      );
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return void this.json(res, 200, {
          ok: true,
          uptimeMs: Date.now() - this.started,
          servers: this.cfg.servers.length,
          tools: this.cfg.servers.reduce((a, s) => a + s.tools.length, 0),
        });
      }
      if (req.method === "GET" && url.pathname === "/metrics") {
        return void this.json(res, 200, this.router.statsSnapshot());
      }
      if (req.method === "GET" && url.pathname === "/cache") {
        return void this.json(res, 200, { note: "tools/list cache flushes on TTL; use POST /cache/invalidate" });
      }
      if (req.method === "POST" && req.url === "/cache/invalidate") {
        return void this.json(res, 200, { ok: true });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [k, v] of Object.entries(req.headersDistinct)) headers[k] = v;
        const out = await this.router.handle(JSON.parse(body), headers);
        const status = (out as { error?: { code: number } }).error ? (out as { error: { code: number } }).error.code : 200;
        return void this.json(res, status, out);
      }
      this.json(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      this.json(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: (err as Error).message } });
    }
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}