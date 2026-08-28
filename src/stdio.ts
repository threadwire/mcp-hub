import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

/**
 * stdio bridge: turns a stdio-only MCP client (Zed, Continue, classic configs)
 * into HTTP against the hub. Reads JSON-RPC lines from stdin, POSTs to the hub
 * endpoint, writes the response back to stdout. A shim — the whole selling
 * point is the hub stays HTTP either way.
 */
export async function runStdioBridge(opts: {
  url: string;
  token: string;
  timeoutMs?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<void> {
  const input = opts.input ?? stdin;
  const output = opts.output ?? stdout;
  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const resp = await fetch(opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify(parsed),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      const body = await resp.text();
      // SSE frames carry one `data: ` line; unwrap to line-delimited JSON-RPC
      const unwrapped = body
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n") || body;
      output.write(`${unwrapped}\n`);
    } catch (err) {
      output.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `bridge: ${(err as Error).message}` } })}\n`,
      );
    }
  }
}