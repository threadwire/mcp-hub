// language: TypeScript, file: src/trace.ts, runtime: node
// Generates a W3C traceparent header for distributed tracing.
// Format: "00-<trace-id>-<span-id>-01"
// trace-id: 16 bytes (32 hex chars), span-id: 8 bytes (16 hex chars).

import { randomBytes } from "crypto";

/**
 * Generate a random hex string of given byte length.
 */
function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Create a traceparent header value.
 *
 * The function follows the W3C Trace‑Context specification (version 00,
 * trace‑flag sampled = 01). It can be used by the hub to propagate tracing
 * information to upstream MCP services.
 */
export function generateTraceparent(): string {
  const version = "00";
  const traceId = hex(16);
  const spanId = hex(8);
  const flags = "01"; // sampled
  return `${version}-${traceId}-${spanId}-${flags}`;
}

/** Parse a W3C traceparent header into its parts ("00" version only). */
export function parseTraceparent(
  tp?: string,
): { traceId: string; spanId: string; sampled: boolean } | null {
  if (!tp) return null;
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(tp);
  if (!m || m[1] !== "00") return null;
  return { traceId: m[2], spanId: m[3], sampled: m[4] === "01" };
}

// Export default for convenience.
export default generateTraceparent;
