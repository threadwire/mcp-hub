import { HubConfig, TenantConfig } from "./types.js";

export interface AuthResult {
  ok: boolean;
  tenant?: TenantConfig;
  reason?: string;
}

/**
 * Bearer token -> tenant. Optionally validates the RFC 8707 resource indicator
 * (what the token is *for*, not just who holds it) and — when the tenant pins an
 * expected issuer — the RFC 9207 `iss` claim.
 */
export function authenticate(
  cfg: HubConfig,
  authHeader: string | undefined,
  resourceHeader: string | undefined,
): AuthResult {
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return { ok: false, reason: "missing Bearer token" };
  }
  const token = authHeader.slice(7).trim();
  for (const tenant of cfg.tenants) {
    if (tenant.tokens.includes(token)) {
      return validateResource(cfg, tenant, resourceHeader);
    }
  }
  return { ok: false, reason: "unknown token" };
}

function validateResource(cfg: HubConfig, tenant: TenantConfig, resource: string | undefined): AuthResult {
  if (tenant.expectedIss && resource) {
    const stated = new URL(resource).host;
    if (stated !== tenant.expectedIss) {
      return { ok: false, reason: `iss mismatch: expected ${tenant.expectedIss}, got ${stated}` };
    }
  }
  return { ok: true, tenant };
}