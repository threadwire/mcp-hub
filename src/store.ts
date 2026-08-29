import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AuditEntry, ServerDef, TenantConfig } from "./types.js";

/**
 * SQLite persistence for registry + audit, via Node's built-in `node:sqlite`.
 * No native build, no runtime dependency — the zero-dep story survives.
 *
 * Tables:
 *   registry_servers  — server name/url/scopes + last sync
 *   registry_tools    — tool name/desc/schema/ttl/cacheScope per server
 *   audit_entries     — every invocation: tenant/tool/status/latency/inputHash
 */
export class HubStore {
  private db: DatabaseSync;

  constructor(public path: string) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS registry_servers (
        name TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        upstream_headers TEXT NOT NULL DEFAULT '{}',
        default_ttl_ms INTEGER NOT NULL DEFAULT 30000,
        synced_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS registry_tools (
        server TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        input_schema TEXT NOT NULL DEFAULT '{}',
        ttl_ms INTEGER,
        cache_scope TEXT NOT NULL DEFAULT 'tenant',
        PRIMARY KEY (server, name)
      );
      CREATE TABLE IF NOT EXISTS audit_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        tenant TEXT NOT NULL,
        tool TEXT NOT NULL,
        server TEXT NOT NULL,
        status TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        input_hash TEXT NOT NULL,
        request_state TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_entries (tool);
      CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_entries (tenant);
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_entries (ts);
    `);
  }

  close(): void {
    this.db.close();
  }

  /* ---- registry persistence ---- */

  saveServer(server: ServerDef): void {
    this.db
      .prepare(
        `INSERT INTO registry_servers (name, url, scopes, upstream_headers, default_ttl_ms, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           url = excluded.url,
           scopes = excluded.scopes,
           upstream_headers = excluded.upstream_headers,
           default_ttl_ms = excluded.default_ttl_ms,
           synced_at = excluded.synced_at`,
      )
      .run(
        server.name,
        server.url,
        JSON.stringify(server.scopes ?? []),
        JSON.stringify(server.upstreamHeaders ?? {}),
        server.defaultTtlMs ?? 30_000,
        Date.now(),
      );
  }

  replaceTools(serverName: string, tools: ServerDef["tools"]): void {
    const del = this.db.prepare("DELETE FROM registry_tools WHERE server = ?");
    const ins = this.db.prepare(
      `INSERT INTO registry_tools (server, name, description, input_schema, ttl_ms, cache_scope)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      del.run(serverName);
      for (const t of tools) {
        ins.run(
          serverName,
          t.name,
          t.description ?? "",
          JSON.stringify(t.inputSchema ?? {}),
          t.ttlMs ?? null,
          t.cacheScope ?? "tenant",
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  loadServer(name: string): ServerDef | undefined {
    const row = this.db.prepare("SELECT * FROM registry_servers WHERE name = ?").get(name) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const tools = this.db
      .prepare("SELECT * FROM registry_tools WHERE server = ? ORDER BY name")
      .all(name) as Array<Record<string, unknown>>;
    return {
      name: row["name"] as string,
      url: row["url"] as string,
      scopes: JSON.parse(row["scopes"] as string) as string[],
      upstreamHeaders: JSON.parse(row["upstream_headers"] as string) as Record<string, string>,
      defaultTtlMs: row["default_ttl_ms"] as number,
      tools: tools.map((t) => ({
        name: t["name"] as string,
        description: (t["description"] as string) || undefined,
        inputSchema: JSON.parse(t["input_schema"] as string) as Record<string, unknown>,
        ttlMs: (t["ttl_ms"] as number | null) ?? undefined,
        cacheScope: (t["cache_scope"] as string) as "user" | "tenant" | "global",
      })),
    };
  }

  allServers(): ServerDef[] {
    const rows = this.db
      .prepare("SELECT * FROM registry_servers ORDER BY name")
      .all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return [];
    const names = rows.map((r) => r["name"] as string);
    // One bulk query for all tools instead of N+1 per-server.
    const tools = this.db
      .prepare(
        `SELECT * FROM registry_tools WHERE server IN (${names.map(() => "?").join(",")}) ORDER BY server, name`,
      )
      .all(...(names as SQLInputValue[])) as Array<Record<string, unknown>>;
    const byServer = new Map<string, ServerDef>();
    for (const row of rows) {
      byServer.set(row["name"] as string, {
        name: row["name"] as string,
        url: row["url"] as string,
        scopes: JSON.parse(row["scopes"] as string) as string[],
        upstreamHeaders: JSON.parse(row["upstream_headers"] as string) as Record<string, string>,
        defaultTtlMs: row["default_ttl_ms"] as number,
        tools: [],
      });
    }
    for (const t of tools) {
      byServer
        .get(t["server"] as string)!
        .tools.push({
          name: t["name"] as string,
          description: (t["description"] as string) || undefined,
          inputSchema: JSON.parse(t["input_schema"] as string) as Record<string, unknown>,
          ttlMs: (t["ttl_ms"] as number | null) ?? undefined,
          cacheScope: (t["cache_scope"] as string) as "user" | "tenant" | "global",
        });
    }
    return [...byServer.values()];
  }

  /* ---- audit persistence ---- */

  audit(entry: Omit<AuditEntry, "ts">): void {
    this.db
      .prepare(
        `INSERT INTO audit_entries (ts, tenant, tool, server, status, latency_ms, input_hash, request_state, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        entry.tenant,
        entry.tool,
        entry.server,
        entry.status,
        entry.latencyMs,
        entry.inputHash,
        entry.requestState ?? null,
        entry.error ?? null,
      );
  }

  queryAudit(opts: { tool?: string; tenant?: string; since?: string; limit?: number; status?: string }): AuditEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.tool) {
      where.push("tool = ?");
      params.push(opts.tool);
    }
    if (opts.tenant) {
      where.push("tenant = ?");
      params.push(opts.tenant);
    }
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.since) {
      where.push("ts >= ?");
      params.push(opts.since);
    }
    const sql = `SELECT ts, tenant, tool, server, status, latency_ms, input_hash, request_state, error
                 FROM audit_entries
                 ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY id DESC LIMIT ?`;
    const rows = this.db
      .prepare(sql)
      .all(...(params as SQLInputValue[]), opts.limit ?? 50) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ts: r["ts"] as string,
      tenant: r["tenant"] as string,
      tool: r["tool"] as string,
      server: r["server"] as string,
      status: r["status"] as AuditEntry["status"],
      latencyMs: r["latency_ms"] as number,
      inputHash: r["input_hash"] as string,
      requestState: (r["request_state"] as string | null) ?? undefined,
      error: (r["error"] as string | null) ?? undefined,
    }));
  }

  /** p50/p95/p99 latency + error rate for a tenant, computed from the real sample. */
  auditSummary(tenant: string): {
    calls: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    errorRate: number;
  } {
    const stats = this.db
      .prepare(
        `SELECT
           COUNT(*) as calls,
           SUM(CASE WHEN status = 'OK' THEN 1 ELSE 0 END) as ok
         FROM audit_entries WHERE tenant = ?`,
      )
      .get(tenant) as { calls: number; ok: number | null };
    const calls = stats.calls ?? 0;
    const lats = (
      this.db
        .prepare("SELECT latency_ms FROM audit_entries WHERE tenant = ? ORDER BY latency_ms")
        .all(tenant) as Array<{ latency_ms: number }>
    ).map((r) => r.latency_ms);
    const q = (p: number): number => {
      if (lats.length === 0) return 0;
      return lats[Math.min(lats.length - 1, Math.floor(p * (lats.length - 1)))];
    };
    const round2 = (n: number): number => Math.round(n * 100) / 100;
    return {
      calls,
      p50LatencyMs: round2(q(0.5)),
      p95LatencyMs: round2(q(0.95)),
      p99LatencyMs: round2(q(0.99)),
      errorRate: calls === 0 ? 0 : round2(((calls - (stats.ok ?? 0)) / calls) * 100),
    };
  }
}

export function serializeTenant(t: TenantConfig): TenantConfig {
  return t;
}