import { TenantConfig } from "./types.js";

/** Sliding-window rate limiter, keyed per tenant. O(1) amortized. */
export class RateLimiter {
  private window: Array<{ key: string; at: number }> = [];

  constructor() {}

  hit(tenant: TenantConfig): { ok: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const cutoff = now - tenant.rate.windowMs;
    this.window = this.window.filter((e) => e.at >= cutoff);
    const recent = this.window.filter((e) => e.key === tenant.id);
    if (recent.length >= tenant.rate.limit) {
      return { ok: false, retryAfterMs: tenant.rate.windowMs - (now - recent[0].at) };
    }
    this.window.push({ key: tenant.id, at: now });
    return { ok: true };
  }
}