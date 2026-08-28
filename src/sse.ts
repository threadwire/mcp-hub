import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Streamable HTTP negotiation (2026-07-28). A client that accepts
 * text/event-stream gets JSON-RPC messages as SSE `data:` frames; plain JSON
 * clients get the same envelope as a normal response. Same semantic, no mode
 * switch in the router — this layer owns the framing only.
 */
export function wantsSse(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("text/event-stream");
}

export function sendSse(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end();
}

export function sseComment(res: ServerResponse, text: string): void {
  res.write(`: ${text}\n\n`);
}