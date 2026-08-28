import { ToolDef } from "./types.js";

/**
 * Context-budget engineering (the "token saver").
 *
 * Agents blow 20k+ tokens just holding tool schemas for a 4-10 server fleet.
 * This module serves LEAN skeletons in tools/list and the FULL schema only for
 * the one tool actually being called (tools/describe) — JIT, per the spec's own
 * `cacheScope`/`ttlMs` guidance. The client sees exactly what it needs, when it
 * needs it, instead of every schema for every server on every turn.
 */
export interface LeanTool {
  name: string;
  hint: string; // one-line, ~48 chars max — enough for tool choice
  required: string[]; // required params only, tells the agent what to gather
  lean: true;
}

export interface FullTool extends LeanTool {
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations: { cacheHint: { ttlMs: number; reusePolicy: string } };
}

const HINT_LIMIT = 48;

export function leanView(tool: ToolDef, ttlMs: number): LeanTool {
  const schema = (tool.inputSchema ?? {}) as { required?: string[] };
  const required = Array.isArray(schema.required) ? schema.required.slice(0, 6) : [];
  return {
    name: tool.name,
    hint: truncateHint(tool.description ?? tool.name, HINT_LIMIT),
    required,
    lean: true,
  };
}

export function fullView(tool: ToolDef, ttlMs: number): FullTool {
  return {
    name: tool.name,
    hint: truncateHint(tool.description ?? tool.name, HINT_LIMIT),
    required: Array.isArray((tool.inputSchema as { required?: string[] })?.required)
      ? ((tool.inputSchema as { required: string[] }).required.slice(0, 6))
      : [],
    description: tool.description,
    inputSchema: tool.inputSchema ?? {},
    annotations: { cacheHint: { ttlMs, reusePolicy: "keep-alive-once" } },
    lean: true,
  };
}

function truncateHint(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

/**
 * Bytes-math for marketing honesty: compare lean skeleton vs full schema BLOBs.
 * Returns how many bytes a client saves *per tools/list* if it only reads the
 * skeleton and pulls full schemas on demand.
 */
export function contextSavings(leanBlob: unknown, fullBlob: unknown): { leanBytes: number; fullBytes: number; savedBytes: number } {
  const leanBytes = JSON.stringify(leanBlob).length;
  const fullBytes = JSON.stringify(fullBlob).length;
  return { leanBytes, fullBytes, savedBytes: Math.max(0, fullBytes - leanBytes) };
}