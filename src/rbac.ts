import { TenantConfig } from "./types.js";

function globToRe(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Per-tenant, per-tool least privilege. `denyTools` wins over `allowTools`.
 * Default: tenant with no allow list may call anything except denied tools.
 */
export function allowed(tenant: TenantConfig, tool: string): boolean {
  if (tenant.denyTools && tenant.denyTools.some((g) => globToRe(g).test(tool))) return false;
  if (tenant.allowTools && tenant.allowTools.length > 0) {
    return tenant.allowTools.some((g) => globToRe(g).test(tool));
  }
  return true;
}