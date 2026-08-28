import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Router } from "./router.js";
import { wantsSse } from "./sse.js";
import { HubConfig, PROTOCOL_VERSION } from "./types.js";

/**
 * Stateless Streamable HTTP endpoint per the 2026-07-28 spec: any container can
 * serve any request, round-robin friendly, no session pinning, no Redis.
 * Binds to loopback by default — never 0.0.0.0 unless you mean it.
 *
 * Surface:
 *   POST /mcp, POST /                 — JSON-RPC (SSE-negotiated when requested)
 *   GET  /health                      — liveness
 *   GET  /metrics                     — router stats {calls, errors, denied, ...}
 *   GET  /admin                       — dashboard (single HTML file)
 *   GET  /admin/servers               — registry, breakers, sync state
 *   GET  /admin/audit?tool&tenant&since — SQL queries against the audit store
 *   POST /admin/sync                  — run discovery now
 *   POST /cache/invalidate            — drop the tools/list cache
 *   GET  /oauth/authorize             — OAuth 2.1 authorization (RFC 8707 resource)
 *   POST /oauth/token                 — authz_code (PKCE) + client_credentials
 */
export class HubServer {
  private router: Router;
  private started = Date.now();
  private http?: ReturnType<typeof createServer>;
  private timer?: NodeJS.Timeout;

  constructor(private cfg: HubConfig, auditPath: string) {
    this.router = new Router(cfg, auditPath);
  }

  async listen(): Promise<void> {
    const srv = createServer((req, res) => void this.route(req, res));
    this.http = srv;
    await new Promise<void>((resolve) => srv.listen(this.cfg.port, this.cfg.bindHost, resolve));
    const tools = this.routerToolsCount();
    console.log(
      `mcp-hub listening on http://${this.cfg.bindHost}:${this.cfg.port} ` +
        `(servers=${this.cfg.servers.length} tools=${tools} tenants=${this.cfg.tenants.length})`,
    );
    if ((this.cfg.syncIntervalMs ?? 0) > 0) {
      this.timer = setInterval(() => {
        void this.router.syncAll().then((reports) => {
          for (const r of reports) if (!r.ok) console.warn(`discovery: ${r.server} — ${r.error}`);
        });
      }, this.cfg.syncIntervalMs!);
      this.timer.unref();
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.router.close();
    if (this.http) await new Promise<void>((resolve, reject) => this.http!.close((e) => (e ? reject(e) : resolve())));
  }

  private routerToolsCount(): number {
    return this.router.toolsCount();
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/mcp")) {
        return void this.json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "GET not supported — POST JSON-RPC" } });
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return void this.json(res, 200, {
          ok: true,
          uptimeMs: Date.now() - this.started,
          servers: this.cfg.servers.length,
          tools: this.routerToolsCount(),
          protocolVersion: PROTOCOL_VERSION,
        });
      }
      if (req.method === "GET" && url.pathname === "/metrics") {
        return void this.json(res, 200, { started: new Date(this.started).toISOString(), ...this.router.statsSnapshot() });
      }
      if (req.method === "POST" && url.pathname === "/cache/invalidate") {
        return void this.json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/oauth/authorize") {
        const params: Record<string, string> = {};
        for (const [k, v] of url.searchParams) params[k] = v;
        const out = this.router.oauthProvider().authorize({
          response_type: params["response_type"] ?? "",
          client_id: params["client_id"] ?? "",
          redirect_uri: params["redirect_uri"] ?? "",
          scope: params["scope"],
          code_challenge: params["code_challenge"],
        });
        if ("code" in out) {
          const redirect = new URL(out.redirect_uri);
          redirect.searchParams.set("code", out.code);
          res.writeHead(302, { location: redirect.toString() });
          return void res.end();
        }
        return void this.json(res, 400, out);
      }
      if (req.method === "POST" && url.pathname === "/oauth/token") {
        const body = await readBody(req);
        const out = this.router.oauthProvider().token(JSON.parse(body));
        return void this.json(res, "access_token" in out ? 200 : 400, out);
      }

      if (req.method === "GET" && url.pathname.startsWith("/admin")) {
        if (!this.adminOk(req)) return void this.json(res, 401, { ok: false, error: "admin token required (x-admin-token or Bearer)" });
        if (url.pathname === "/admin") return void this.html(res, DASHBOARD);
        if (url.pathname === "/admin/servers") return void this.json(res, 200, this.adminServers());
        if (url.pathname === "/admin/audit") {
          return void this.json(res, 200, {
            entries: this.router.auditQuery({
              tool: url.searchParams.get("tool") ?? undefined,
              tenant: url.searchParams.get("tenant") ?? undefined,
              since: url.searchParams.get("since") ?? undefined,
            }),
          });
        }
        if (url.pathname === "/admin/stats") return void this.json(res, 200, this.router.statsSnapshot());
        return void this.json(res, 404, { ok: false, error: "not found" });
      }
      if (req.method === "POST" && url.pathname === "/admin/sync") {
        if (!this.adminOk(req)) return void this.json(res, 401, { ok: false, error: "admin token required" });
        const reports = await this.router.syncAll();
        return void this.json(res, 200, { reports });
      }

      if (req.method === "POST" && (url.pathname === "/mcp" || url.pathname === "/")) {
        const body = await readBody(req);
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [k, v] of Object.entries(req.headersDistinct)) headers[k] = v;
        const out = await this.router.handle(JSON.parse(body), headers);
        const status = (out as { error?: { code: number } }).error ? (out as { error: { code: number } }).error.code : 200;
        if (wantsSse(req)) {
          res.writeHead(status, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "connection": "keep-alive",
            "x-accel-buffering": "no",
          });
          res.write(`data: ${JSON.stringify(out)}\n\n`);
          return void res.end();
        }
        return void this.json(res, status, out);
      }
      this.json(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      this.json(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: (err as Error).message } });
    }
  }

  private adminOk(req: IncomingMessage): boolean {
    const cfgToken = this.cfg.adminToken;
    if (!cfgToken) return false;
    const auth = req.headers["authorization"] ?? req.headers["x-admin-token"];
    const value = Array.isArray(auth) ? auth[0] : auth;
    return value === cfgToken || value === `Bearer ${cfgToken}`;
  }

  private adminServers(): unknown {
    const servers = this.router.registryServers();
    return {
      servers: servers.map((s) => ({
        name: s.name,
        url: s.url,
        scopes: s.scopes,
        tools: s.tools.length,
        defaultTtlMs: s.defaultTtlMs,
      })),
      breakers: this.router.breakersSnapshot(),
    };
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  }

  private html(res: ServerResponse, body: string): void {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  }
}

const DASHBOARD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>mcp-hub · dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, monospace; margin: 0; padding: 2rem; background: #0d1117; color: #e6edf3; }
  h1 { font-size: 1.2rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin: 1rem 0 2rem; }
  .card { border: 1px solid #30363d; border-radius: 8px; padding: 1rem; background: #161b22; }
  .card b { display: block; color: #7ee787; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .3rem .6rem; border-bottom: 1px solid #21262d; }
  .err { color: #f85149; }
  input { background: #0d1117; border: 1px solid #30363d; color: inherit; padding: .25rem .5rem; font: inherit; }
  button { background: #238636; border: 0; color: #fff; padding: .4rem .8rem; font: inherit; cursor: pointer; border-radius: 6px; }
</style>
</head>
<body>
<h1>mcp-hub · live dashboard</h1>
<div class="cards">
  <div class="card"><b id="servers">–</b>upstream servers</div>
  <div class="card"><b id="tools">–</b>tools (store)</div>
  <div class="card" id="states"><b>–</b>circuits</div>
</div>
<label>admin token <input id="token" placeholder="x-admin-token" type="password"/></label>
<button onclick="boot()">refresh</button>
<h2>audit</h2>
<label>tool <input id="tool" placeholder="filter"/></label>
<label>tenant <input id="tenant" placeholder="filter"/></label>
<button onclick="loadAudit()">run query</button>
<table id="audit"><thead><tr><th>ts</th><th>tenant</th><th>tool</th><th>status</th><th>latency</th><th>error</th></tr></thead><tbody></tbody></table>
<script>
const h = id => document.getElementById(id);
async function j(path, token) {
  const r = await fetch(path, { headers: { 'x-admin-token': token } });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
let token = '';
async function boot() {
  token = h('token').value;
  try {
    const s = await j('/admin/servers', token);
    h('servers').textContent = s.servers.length;
    h('tools').textContent = s.servers.reduce((a, x) => a + x.tools, 0);
    const states = Object.entries(s.breakers).map(([k, v]) => k + ':' + v.state).join(', ') || 'no calls yet';
    h('states').textContent = states;
  } catch { h('states').textContent = 'auth required'; }
  await loadAudit();
}
async function loadAudit() {
  const q = new URLSearchParams({ tool: h('tool').value, tenant: h('tenant').value }).toString();
  try {
    const a = await j('/admin/audit?' + q, token);
    const tb = h('audit').querySelector('tbody');
    tb.innerHTML = '';
    for (const e of a.entries) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + e.ts.slice(0, 19) + '</td><td>' + e.tenant + '</td><td>' + e.tool + '</td><td>' + e.status + '</td><td>' + e.latencyMs + 'ms</td><td class="err">' + (e.error ?? '') + '</td>';
      tb.appendChild(tr);
    }
  } catch { /* ignore */ }
}
boot();
</script>
</body>
</html>`;

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