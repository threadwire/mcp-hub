import { Audit, sha256Short } from "./audit.js";
import { authenticate } from "./auth.js";
import { ToolCache, cacheKey } from "./cache.js";
import { UpstreamProxy, RpcError } from "./proxy.js";
import { RateLimiter } from "./rate.js";
import { Registry } from "./registry.js";
import { allowed } from "./rbac.js";
import { HubConfig, PROTOCOL_VERSION } from "./types.js";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface RouterStats {
  calls: Record<string, number>;
  errors: number;
  denied: number;
  rateLimited: number;
}

export class Router {
  private audit: Audit;
  private cache = new ToolCache();
  private rate = new RateLimiter();
  private stats: RouterStats = { calls: {}, errors: 0, denied: 0, rateLimited: 0 };
  private discoveryCache: Map<string, { payload: unknown; at: number; ttlMs: number }> = new Map();

  constructor(private cfg: HubConfig, auditPath: string) {
    this.audit = new Audit(auditPath);
  }

  /** Handle a JSON-RPC envelope. Returns the response object. */
  async handle(incoming: unknown, headers: Record<string, string | string[] | undefined>): Promise<unknown> {
    const auth = authenticate(this.cfg, h(headers, "authorization"), h(headers, "x-mcp-resource"));
    if (!auth.ok) return rpcError(undefined, 401, auth.reason ?? "unauthorized", null);

    const tenant = auth.tenant!;
    const req = parseRequest(incoming);
    if (!req) return rpcError(undefined, -32700, "Parse error", null);

    switch (req.method) {
      case "initialize":
        return rpcResult(req.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          serverInfo: { name: "mcp-hub", version: "0.1.0" },
        });
      case "ping":
        return rpcResult(req.id, {});
      case "tools/list":
        return rpcResult(req.id, await this.toolsList(tenant.id));
      case "tools/call":
        return this.toolsCall(req, tenant.id);
      default:
        return rpcError(req.id, -32601, `Method not found: ${req.method}`, null);
    }
  }

  private async toolsList(tenantId: string): Promise<{ tools: unknown[] }> {
    const key = cacheKey("tenant", tenantId);
    const hit = this.cache.get(key);
    if (hit.fresh && hit.payload !== undefined) return hit.payload as { tools: unknown[] };

    const tools = this.cfg.servers.flatMap((server) =>
      server.tools
        .filter((t) => allowed(this.cfg.tenants.find((x) => x.id === tenantId)!, t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { cacheHint: { ttlMs: t.ttlMs ?? server.defaultTtlMs ?? 30_000 } },
        })),
    );
    const payload = { tools };
    this.cache.set(key, "hub", payload, 30_000, "tenant");
    return payload;
  }

  private async toolsCall(
    req: RpcRequest,
    tenantId: string,
  ): Promise<{ jsonrpc: "2.0"; id?: number | string | null; result?: unknown; error?: unknown }> {
    const tenant = this.cfg.tenants.find((t) => t.id === tenantId)!;
    const name = (req.params?.name as string) ?? "";
    const args = (req.params?.arguments as Record<string, unknown>) ?? {};
    const found = this.registry().serverForTool(name);
    if (!found) {
      this.stats.errors++;
      return rpcError(req.id, -32602, `unknown tool: ${name}`, null);
    }
    if (!allowed(tenant, name)) {
      this.stats.denied++;
      this.audit.record({
        tenant: tenantId,
        tool: name,
        server: found.server.name,
        status: "DENIED",
        latencyMs: 0,
        inputHash: sha256Short(JSON.stringify(args)),
      });
      return rpcError(req.id, 403, `tenant ${tenantId} is not allowed to call ${name}`, { requestState: null });
    }
    const rate = this.rate.hit(tenant);
    if (!rate.ok) {
      this.stats.rateLimited++;
      this.audit.record({
        tenant: tenantId,
        tool: name,
        server: found.server.name,
        status: "RATE_LIMITED",
        latencyMs: 0,
        inputHash: sha256Short(JSON.stringify(args)),
        error: `retryAfterMs=${rate.retryAfterMs}`,
      });
      return rpcError(req.id, 429, "rate limit exceeded", { retryAfterMs: rate.retryAfterMs });
    }

    this.stats.calls[name] = (this.stats.calls[name] ?? 0) + 1;
    const t0 = Date.now();
    try {
      const proxy = new UpstreamProxy(found.server);
      const { result, requestState } = await proxy.call(name, args);
      const latencyMs = Date.now() - t0;
      this.audit.record({ tenant: tenantId, tool: name, server: found.server.name, status: "OK", latencyMs, inputHash: sha256Short(JSON.stringify(args)), requestState });
      return { jsonrpc: "2.0", id: req.id, result: { ...result, requestState } };
    } catch (err) {
      this.stats.errors++;
      const latencyMs = Date.now() - t0;
      const e = err as RpcError;
      this.audit.record({ tenant: tenantId, tool: name, server: found.server.name, status: "ERROR", latencyMs, inputHash: sha256Short(JSON.stringify(args)), error: e.message, requestState: (e.data as { requestState?: string })?.requestState });
      return rpcError(req.id, e.code, e.message, e.data ?? null);
    }
  }

  private registry(): Registry {
    return new Registry(this.cfg);
  }

  refreshDiscovery(): void {
    // placeholder for background tools/list refresh; skipped without a scheduler
  }

  statsSnapshot(): RouterStats {
    return this.stats;
  }
}

function parseRequest(x: unknown): RpcRequest | null {
  if (typeof x !== "object" || x === null) return null;
  const r = x as RpcRequest;
  if (r.jsonrpc !== "2.0" || typeof r.method !== "string") return null;
  return r;
}

function h(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function rpcResult(id: number | string | undefined, result: unknown): { jsonrpc: "2.0"; id: number | string | null; result: unknown } {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(
  id: number | string | undefined,
  code: number,
  message: string,
  data: unknown,
): { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string; data: unknown } } {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}