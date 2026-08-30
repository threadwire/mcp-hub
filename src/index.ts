/**
 * mcp-hub public surface.
 *
 * Gateway as a library: import { HubServer, Router } from "@threadwire/mcp-hub"
 * and embed the whole gateway — or just the transport-agnostic Router — into
 * your own Node service. The CLI in `cli.ts` is nothing but a thin wrapper
 * over these same classes.
 */
export { HubServer } from "./server.js";
export { Router } from "./router.js";
export { HubStore } from "./store.js";
export { Discovery } from "./discovery.js";
export { Pipeline } from "./plugin.js";
export { runStdioBridge } from "./stdio.js";
export { HUB_VERSION } from "./version.js";
export { PROTOCOL_VERSION } from "./types.js";

export type {
  HubConfig,
  TenantConfig,
  ServerDef,
  ToolDef,
  AuditEntry,
  ToolResult,
} from "./types.js";