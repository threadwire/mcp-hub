import { randomUUID } from "node:crypto";
import type { ServerDef, ToolResult } from "./types.js";

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Stateless proxy to one upstream Streamable HTTP MCP server.
 * JSON-RPC 2.0 framing; structured errors; each invoke carries a fresh
 * requestState (retry/dedup idempotency key) so a resumed call can never
 * double-fire a side-effecting tool.
 */
export class UpstreamProxy {
  constructor(private server: ServerDef) {}

  async discover(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }>; ttlMs?: number }> {
    const res = await this.post("tools/list", {});
    const tools = ((res.result as { tools?: unknown[] })?.tools ?? []) as Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }>;
    const ttlMs = (res.result as { ttlMs?: number } | undefined)?.ttlMs;
    return { tools, ttlMs };
  }

  async call(name: string, args: unknown, extraHeaders?: Record<string, string>): Promise<{ result: ToolResult; requestState: string }> {
    const requestState = randomUUID();
    let res: RpcResponse;
    try {
      res = await this.post("tools/call", { name, arguments: args, requestState }, extraHeaders);
    } catch (err) {
      throw new RpcError(500, `upstream transport failure: ${(err as Error).message}`);
    }
    if (res.error) {
      const seen = res.error.data as { requestState?: string } | undefined;
      throw new RpcError(res.error.code, res.error.message, {
        requestState: seen?.requestState ?? requestState,
        retryable: res.error.code >= 500 || res.error.code === -32603,
      });
    }
    return { result: res.result as ToolResult, requestState };
  }

  private async post(method: string, params: unknown, extraHeaders?: Record<string, string>): Promise<RpcResponse> {
    const url = this.server.url.endsWith("/") ? this.server.url : `${this.server.url}/`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await fetch(`${url}mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: this.server.upstreamHeaders?.authorization ?? "",
          ...(this.server.upstreamHeaders ?? {}),
          ...(extraHeaders ?? {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new RpcError(resp.status, `upstream HTTP ${resp.status}`);
      return (await resp.json()) as RpcResponse;
    } finally {
      clearTimeout(t);
    }
  }
}