import type { ToolDef } from "./types.js";

interface CacheCell {
  payload: unknown;
  // ttlMs + cacheScope modeled after the 2026-07-28 spec's tools/list caching
  expiresAt: number;
  scope: string;
  serverName: string;
}

/**
 * tools/list caching. The spec lets a server return ttlMs + cacheScope so the
 * client knows how long a discovery response stays fresh and whether it is safe
 * to reuse across users. This is that cache, on the gateway side, so a fleet of
 * 10 servers answers discovery in one round trip per refresh — not ten.
 */
export class ToolCache {
  private cells = new Map<string, CacheCell>();

  get(key: string): { payload: unknown; fresh: boolean } {
    const cell = this.cells.get(key);
    if (!cell) return { payload: undefined, fresh: false };
    const fresh = Date.now() < cell.expiresAt;
    return { payload: cell.payload, fresh };
  }

  set(key: string, serverName: string, payload: unknown, ttlMs: number, scope: string): void {
    this.cells.set(key, {
      payload,
      expiresAt: Date.now() + ttlMs,
      scope,
      serverName,
    });
  }

  invalidate(serverName?: string): void {
    if (!serverName) {
      this.cells.clear();
      return;
    }
    for (const [k, v] of this.cells) if (v.serverName === serverName) this.cells.delete(k);
  }

  stats(): { size: number; keys: string[] } {
    return { size: this.cells.size, keys: [...this.cells.keys()] };
  }
}

export function cacheKey(scope: string, tenantScope: string): string {
  return scope === "global" ? "global" : `${scope}:${tenantScope}`;
}