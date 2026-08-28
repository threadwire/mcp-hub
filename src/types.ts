export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  ttlMs?: number;
  cacheScope?: "user" | "tenant" | "global";
}

export interface ServerDef {
  name: string;
  url: string;
  upstreamHeaders?: Record<string, string>;
  scopes: string[];
  defaultTtlMs?: number;
  tools: ToolDef[];
}

export interface TenantConfig {
  id: string;
  tokens: string[];
  allowTools?: string[]; // globs; default *=everything
  denyTools?: string[]; // globs; default none
  rate: { windowMs: number; limit: number };
  expectedIss?: string | null; // RFC 9207 issuer validation
}

export interface HubConfig {
  bindHost: string;
  port: number;
  servers: ServerDef[];
  tenants: TenantConfig[];
  syncIntervalMs?: number; // 0 disables background discovery sync
  adminToken?: string;
  oauthClients?: Array<{ clientId: string; clientSecret?: string | null; scopes?: string[] }>;
  plugins?: Array<import("./plugin.js").Plugin>;
}

export interface AuditEntry {
  ts: string;
  tenant: string;
  tool: string;
  server: string;
  status: "OK" | "ERROR" | "DENIED" | "RATE_LIMITED";
  latencyMs: number;
  inputHash: string;
  requestState?: string;
  error?: string;
}

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export const PROTOCOL_VERSION = "2026-07-28";