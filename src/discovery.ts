import { UpstreamProxy } from "./proxy.js";
import { HubStore } from "./store.js";
import { HubConfig, ServerDef, ToolDef } from "./types.js";

export interface SyncReport {
  server: string;
  ok: boolean;
  toolsFound: number;
  ttlMs?: number;
  error?: string;
}

/**
 * Auto-discovery: pulls the real `tools/list` from each upstream and persists
 * it into the store — so you never hand-declare tools. Declared tools act as a
 * seed; a successful sync replaces the seed for that server.
 */
export class Discovery {
  constructor(
    private store: HubStore,
    private cfg: HubConfig,
  ) {}

  async syncServer(server: ServerDef): Promise<SyncReport> {
    const proxy = new UpstreamProxy(server);
    try {
      const { tools, ttlMs } = await proxy.discover();
      const mapped: ToolDef[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
        ttlMs: ttlMs ?? server.defaultTtlMs ?? 30_000,
        cacheScope: "tenant",
      }));
      this.store.saveServer({ ...server, defaultTtlMs: ttlMs ?? server.defaultTtlMs, tools: mapped });
      this.store.replaceTools(server.name, mapped);
      return { server: server.name, ok: true, toolsFound: mapped.length, ttlMs };
    } catch (err) {
      return { server: server.name, ok: false, toolsFound: 0, error: (err as Error).message };
    }
  }

  async syncAll(): Promise<SyncReport[]> {
    const servers = this.effectiveServers();
    const reports: SyncReport[] = [];
    for (const s of servers) reports.push(await this.syncServer(s));
    return reports;
  }

  /** Also refresh the in-memory registry cache used by the router. */
  effectiveServers(): ServerDef[] {
    const stored = this.store.allServers();
    return stored.length > 0 ? stored : this.cfg.servers;
  }

  close(): void {
    this.store.close();
  }
}