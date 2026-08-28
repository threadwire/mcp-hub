export type BeforeHook = (ctx: {
  tenantId: string;
  tool: string;
  serverName: string;
  argsBox: { args: Record<string, unknown> };
}) => Promise<void> | void;

export type AfterHook = (ctx: {
  tenantId: string;
  tool: string;
  serverName: string;
  args: Record<string, unknown>;
  latencyMs: number;
  status: "OK";
}) => Promise<void> | void;

export type ErrorHook = (ctx: {
  tenantId: string;
  tool: string;
  serverName: string;
  error: Error;
}) => Promise<void> | void;

export interface Plugin {
  name: string;
  before?: BeforeHook;
  after?: AfterHook;
  error?: ErrorHook;
}

/**
 * Middleware pipeline for a tool call. Plugins declare before/after/error hooks
 * and the router runs them in registration order. Plugins can veto in `before`
 * by throwing, and can mutate `argsBox.args` (redaction) before the request is
 * forwarded upstream or written to audit.
 */
export class Pipeline {
  private plugins: Plugin[] = [];

  use(p: Plugin): this {
    this.plugins.push(p);
    return this;
  }

  async runBefore(ctx: Parameters<BeforeHook>[0]): Promise<void> {
    for (const p of this.plugins) if (p.before) await p.before(ctx);
  }

  async runAfter(ctx: Parameters<AfterHook>[0]): Promise<void> {
    for (const p of this.plugins) if (p.after) await p.after(ctx);
  }

  async runError(ctx: Parameters<ErrorHook>[0]): Promise<void> {
    for (const p of this.plugins) if (p.error) await p.error(ctx);
  }
}

/** Example: veto tools by regex unless an env gate is open. */
export function ApprovalPlugin(opts: { require: RegExp; gate: () => boolean }): Plugin {
  return {
    name: "approval",
    before: (ctx) => {
      if (opts.require.test(ctx.tool) && !opts.gate()) {
        throw new Error(`tool ${ctx.tool} needs manual approval`);
      }
    },
  };
}

/** Example: guarantee secret keys never leave the gateway upstream. */
export function RedactPlugin(secretKeys: RegExp[]): Plugin {
  const REDACTED = "[REDACTED]";
  return {
    name: "redact",
    before: (ctx) => {
      const scrub = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(scrub);
        if (node && typeof node === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            out[k] = secretKeys.some((re) => re.test(k)) ? REDACTED : scrub(v);
          }
          return out;
        }
        return node;
      };
      ctx.argsBox.args = scrub(ctx.argsBox.args) as Record<string, unknown>;
    },
  };
}