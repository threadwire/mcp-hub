import { HubStore } from "./store.js";
import { sha256Short } from "./audit.js";
import { authenticate } from "./auth.js";
import { ToolCache, cacheKey } from "./cache.js";
import { UpstreamProxy, RpcError } from "./proxy.js";
import { RateLimiter } from "./rate.js";
import { Registry } from "./registry.js";
import { allowed } from "./rbac.js";
import { leanView, fullView, contextSavings } from "./context.js";
import { HubConfig, PROTOCOL_VERSION, ServerDef, TenantConfig } from "./types.js";
import { BreakerRegistry } from "./circuit.js";
import { Pipeline } from "./plugin.js";
import { generateTraceparent, parseTraceparent } from "./trace.js";
import { Discovery } from "./discovery.js";
import { OAuthProvider } from "./oauth.js";
import { HUB_VERSION } from "./version.js";

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

const DEFAULT_AUDIT_RETENTION_MS = 30 * 24 * 3600_000;

export class Router {
  private store: HubStore;
  private cache = new ToolCache();
  private rate = new RateLimiter();
  private pipeline = new Pipeline();
  private breakers = new BreakerRegistry();
  private discovery: Discovery;
  private oauth: OAuthProvider;
  private pruneTimer?: NodeJS.Timeout;
  private stats: RouterStats = { calls: {}, errors: 0, denied: 0, rateLimited: 0 };

  constructor(private cfg: HubConfig, auditPath: string) {
    this.store = new HubStore(auditPath);
    this.discovery = new Discovery(this.store, cfg);
    this.oauth = new OAuthProvider(cfg);
    for (const c of cfg.oauthClients ?? []) this.oauth.registerClient(c.clientId, c.clientSecret ?? null);
    for (const p of cfg.plugins ?? []) this.pipeline.use(p);
    const retention = cfg.auditRetentionMs ?? DEFAULT_AUDIT_RETENTION_MS;
    if (retention > 0) {
      this.store.prune(retention); // catch up on downtime at boot
      this.pruneTimer = setInterval(() => this.store.prune(retention), 3600_000).unref();
    }
  }

  /** Handle a JSON-RPC envelope. Returns the response object. */
  async handle(incoming: unknown, headers: Record<string, string | string[] | undefined>): Promise<unknown> {
    const auth = this.authenticateWithOauth(headers);
    if (!auth) return rpcError(undefined, 401, "unauthorized", null);

    const tenant = auth;
    const req = parseRequest(incoming);
    if (!req) return rpcError(undefined, -32700, "Parse error", null);

    switch (req.method) {
      case "initialize":
        return rpcResult(req.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          serverInfo: { name: "mcp-hub", version: HUB_VERSION },
        });
      case "ping":
        return rpcResult(req.id, {});
      case "tools/list":
        return rpcResult(req.id, await this.toolsList(tenant.id));
      case "tools/describe":
        try {
          return rpcResult(req.id, await this.toolDescribe(req.params?.name as string, tenant.id));
        } catch (err) {
          const e = err as RpcError;
          return rpcError(req.id, e.code, e.message, e.data ?? null);
        }
      case "tools/call": {
        const traceparent = h(headers, "traceparent") || generateTraceparent();
        return this.toolsCall(req, tenant.id, traceparent);
      }
      default:
        return rpcError(req.id, -32601, `Method not found: ${req.method}`, null);
    }
  }

  private async toolDescribe(name: string, tenantId: string): Promise<unknown> {
    const tenant = this.cfg.tenants.find((t) => t.id === tenantId)!;
    const found = this.registry().serverForTool(name);
    if (!found) throw new RpcError(-32602, `unknown tool: ${name}`);
    if (!allowed(tenant, name)) throw new RpcError(403, `tenant ${tenantId} is not allowed to call ${name}`);
    const ttl = found.tool.ttlMs ?? found.server.defaultTtlMs ?? 30_000;
    return fullView(found.tool, ttl);
  }

  private async toolsList(tenantId: string): Promise<{ tools: unknown[]; meta: Record<string, unknown> }> {
    const key = cacheKey("tenant", tenantId);
    const hit = this.cache.get(key);
    if (hit.fresh && hit.payload !== undefined) return hit.payload as { tools: unknown[]; meta: Record<string, unknown> };

    const tenant = this.cfg.tenants.find((x) => x.id === tenantId)!;
    const entries = this.registry()
      .allTools()
      .filter(({ tool }) => allowed(tenant, tool.name));

    const tools = entries.map(({ server, tool }) => {
      const ttl = tool.ttlMs ?? server.defaultTtlMs ?? 30_000;
      return leanView(tool, ttl);
    });
    const leanBlob = { tools };
    const fullBlob = {
      tools: entries.map(({ server, tool }) => fullView(tool, tool.ttlMs ?? server.defaultTtlMs ?? 30_000)),
    };
    const budget = contextSavings(leanBlob, fullBlob);
    const payload = {
      tools,
      meta: {
        lean: true,
        protocolHint: "call tools/describe <name> for the full schema before invoking",
        tokenBudget: { ...budget, unit: "bytes" },
      },
    };
    this.cache.set(key, "hub", payload, 30_000, "tenant");
    return payload;
  }

  private async toolsCall(
    req: RpcRequest,
    tenantId: string,
    traceparent?: string,
  ): Promise<{ jsonrpc: "2.0"; id?: number | string | null; result?: unknown; error?: unknown }> {
    const tenant = this.cfg.tenants.find((t) => t.id === tenantId)!;
    const name = (req.params?.name as string) ?? "";
    const args = (req.params?.arguments as Record<string, unknown>) ?? {};
    const found = this.registry().serverForTool(name);
    if (!found) {
      this.stats.errors++;
      this.emitSpan({ tenantId, tool: name, status: "ERROR", error: `unknown tool: ${name}`, args }, traceparent);
      return rpcError(req.id, -32602, `unknown tool: ${name}`, null);
    }
    if (!allowed(tenant, name)) {
      this.stats.denied++;
      this.store.audit({
        tenant: tenantId,
        tool: name,
        server: found.server.name,
        status: "DENIED",
        latencyMs: 0,
        inputHash: sha256Short(JSON.stringify(args)),
      });
      this.emitSpan({ tenantId, tool: name, server: found.server.name, status: "DENIED", args }, traceparent);
      return rpcError(req.id, 403, `tenant ${tenantId} is not allowed to call ${name}`, { requestState: null });
    }
    const rate = this.rate.hit(tenant);
    if (!rate.ok) {
      this.stats.rateLimited++;
      this.store.audit({
        tenant: tenantId,
        tool: name,
        server: found.server.name,
        status: "RATE_LIMITED",
        latencyMs: 0,
        inputHash: sha256Short(JSON.stringify(args)),
        error: `retryAfterMs=${rate.retryAfterMs}`,
      });
      this.emitSpan({ tenantId, tool: name, server: found.server.name, status: "RATE_LIMITED", args }, traceparent);
      return rpcError(req.id, 429, "rate limit exceeded", { retryAfterMs: rate.retryAfterMs });
    }

    this.stats.calls[name] = (this.stats.calls[name] ?? 0) + 1;
    const breaker = this.breakers.for(found.server.name);
    if (breaker.isOpen) {
      const retryAfterMs = breaker.retryAfterMs();
      this.emitSpan({ tenantId, tool: name, server: found.server.name, status: "ERROR", error: `circuit_open retryAfterMs=${retryAfterMs}`, args }, traceparent);
      this.store.audit({ tenant: tenantId, tool: name, server: found.server.name, status: "ERROR", latencyMs: 0, inputHash: sha256Short(JSON.stringify(args)), error: `circuit_open retryAfterMs=${retryAfterMs}` });
      return rpcError(req.id, 503, `upstream ${found.server.name} circuit open`, { retryAfterMs, circuit: "open" });
    }
    try {
      await this.pipeline.runBefore({ tenantId, tool: name, serverName: found.server.name, argsBox: { args } });
    } catch (pluginErr) {
      this.stats.errors++;
      this.emitSpan({ tenantId, tool: name, server: found.server.name, status: "ERROR", error: `plugin:${(pluginErr as Error).message}`, args }, traceparent);
      this.store.audit({ tenant: tenantId, tool: name, server: found.server.name, status: "ERROR", latencyMs: 0, inputHash: sha256Short(JSON.stringify(args)), error: `plugin:${(pluginErr as Error).message}` });
      return rpcError(req.id, -32603, (pluginErr as Error).message, { plugin: true });
    }
    const t0 = Date.now();
    try {
      const proxy = new UpstreamProxy(found.server);
      const { result, requestState } = await proxy.call(name, args, traceparent ? { traceparent } : undefined);
      const latencyMs = Date.now() - t0;
      breaker.onSuccess();
      this.emitSpan({ tenantId, tool: name, server: found.server.name, status: "OK", latencyMs, inputHash: sha256Short(JSON.stringify(args)) }, traceparent);
      this.store.audit({ tenant: tenantId, tool: name, server: found.server.name, status: "OK", latencyMs, inputHash: sha256Short(JSON.stringify(args)), requestState });
      await this.pipeline.runAfter({ tenantId, tool: name, serverName: found.server.name, args, latencyMs, status: "OK" });
      return { jsonrpc: "2.0", id: req.id, result: { ...result, requestState } };
    } catch (err) {
      this.stats.errors++;
      const latencyMs = Date.now() - t0;
      const e = err as RpcError;
      breaker.onFailure();
      this.emitSpan({ tenantId, tool: name, server: found.server.name, status: "ERROR", latencyMs, error: e.message, args }, traceparent);
      await this.pipeline.runError({ tenantId, tool: name, serverName: found.server.name, error: e });
      this.store.audit({ tenant: tenantId, tool: name, server: found.server.name, status: "ERROR", latencyMs, inputHash: sha256Short(JSON.stringify(args)), error: e.message, requestState: (e.data as { requestState?: string })?.requestState });
      return rpcError(req.id, e.code, e.message, e.data ?? null);
    }
  }

  private authenticateWithOauth(headers: Record<string, string | string[] | undefined>): TenantConfig | null {
    const auth = authenticate(this.cfg, h(headers, "authorization"), h(headers, "x-mcp-resource"));
    if (auth.ok && auth.tenant) return auth.tenant;
    // OAuth: opaque hub_ tokens minted by our /oauth/token, scoped to a tenant
    const bearer = h(headers, "authorization")?.replace(/^Bearer\s+/i, "");
    if (!bearer?.startsWith("hub_")) return null;
    const issued = this.oauth.validate(bearer);
    if (!issued) return null;
    return this.cfg.tenants.find((t) => t.id === issued.tenantId) ?? null;
  }

  private registry(): Registry {
    const stored = this.store.allServers();
    // Store wins when present (discovery has refreshed it); else config stands.
    const effectiveServers: ServerDef[] =
      stored.length > 0 ? stored : this.cfg.servers;
    return new Registry({ ...this.cfg, servers: effectiveServers });
  }

  async syncAll(): Promise<import("./discovery.js").SyncReport[]> {
    return this.discovery.syncAll();
  }

  invalidateCache(serverName?: string): number {
    return this.cache.invalidate(serverName);
  }

  toolsCount(): number {
    return this.registry().allTools().length;
  }

  registryServers(): ServerDef[] {
    const stored = this.store.allServers();
    return stored.length > 0 ? stored : this.cfg.servers;
  }

  close(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.store.close();
  }

  oauthProvider(): OAuthProvider {
    return this.oauth;
  }

  breakersSnapshot(): Record<string, { state: string; failures: number }> {
    return this.breakers.snapshots();
  }

  auditQuery(opts: { tool?: string; tenant?: string; since?: string }): import("./types.js").AuditEntry[] {
    return this.store.queryAudit(opts);
  }

  statsSnapshot(): RouterStats {
    return this.stats;
  }

  /** Fire-and-forget span to the mcp-trace bridge. Never blocks or throws. */
  private emitSpan(
    opts: {
      tenantId: string;
      tool: string;
      server?: string;
      status: string;
      latencyMs?: number;
      error?: string;
      inputHash?: string;
      args?: unknown;
    },
    traceparent?: string,
  ): void {
    const base = this.cfg.telemetryUrl;
    if (!base) return;
    const now = Date.now() / 1000;
    const parsed = parseTraceparent(traceparent);
    const traceId = parsed ? parsed.traceId : `${Date.now()}`;
    const span = {
      name: `${opts.tool} gen_ai.client.tool_call`,
      kind: "gen_ai.client.tool_call",
      tool: opts.tool,
      server: opts.server ?? null,
      start: now,
      end: now,
      status: opts.status,
      error: opts.error ?? null,
      input_hash:
        opts.inputHash ?? (opts.args === undefined ? null : sha256Short(JSON.stringify(opts.args))),
      latency_ms: opts.latencyMs ?? 0,
      parent_span_id: parsed ? parsed.spanId : null,
    };
    const body = JSON.stringify({ id: traceId, started: now, spans: [span] });
    const url = `${base.replace(/\/+$/, "")}/ingest`;
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(2000),
    }).catch(() => {
      // bridge must never affect the request path
    });
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