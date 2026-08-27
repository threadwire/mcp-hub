#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Audit } from "./audit.js";
import { HubServer } from "./server.js";
import { HubConfig, ServerDef, ToolDef } from "./types.js";

const HUB_DIR = process.env.MCP_HUB_DIR ?? join(homedir(), ".mcp-hub");
const CONFIG_PATH = join(HUB_DIR, "config.json");
const AUDIT_PATH = join(HUB_DIR, "audit.jsonl");

const DEFAULT_TOKEN = "mcp-hub-dev-token";

const DEFAULT_CONFIG: HubConfig = {
  bindHost: "127.0.0.1",
  port: 8801,
  servers: [],
  tenants: [
    {
      id: "dev",
      tokens: [DEFAULT_TOKEN],
      denyTools: [],
      allowTools: [],
      rate: { windowMs: 60_000, limit: 120 },
      expectedIss: null,
    },
  ],
};

function loadConfig(): HubConfig {
  if (!existsSync(CONFIG_PATH)) throw new Error(`no config at ${CONFIG_PATH} — run \`mcp-hub init\``);
  return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as HubConfig) };
}

function saveConfig(cfg: HubConfig): void {
  mkdirSync(HUB_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

function cmdInit(): number {
  if (!existsSync(CONFIG_PATH)) saveConfig(DEFAULT_CONFIG);
  console.log(`config ready: ${CONFIG_PATH}`);
  console.log(`dev token:   ${DEFAULT_TOKEN}`);
  console.log(`add a server:\n  mcp-hub add <name> <streamable-http-url> --tools tool1,tool2 --scopes read,write`);
  return 0;
}

function cmdAdd(args: string[]): number {
  const cfg = loadConfig();
  const name = args[0];
  const url = args[1];
  if (!name || !url) {
    console.error("usage: mcp-hub add <name> <url> [--tools a,b] [--scopes r,w]");
    return 1;
  }
  const toolsArg = flag(args, "--tools");
  const scopesArg = flag(args, "--scopes") ?? "read";
  const tools: ToolDef[] = (toolsArg ?? "")
    .split(",")
    .filter(Boolean)
    .map((t) => ({ name: t, cacheScope: "tenant" }));
  const server: ServerDef = { name, url, scopes: scopesArg.split(","), tools };
  cfg.servers.push(server);
  saveConfig(cfg);
  console.log(`registered ${name} @ ${url} (${tools.length} tools)`);
  return 0;
}

function cmdList(): number {
  const cfg = loadConfig();
  if (cfg.servers.length === 0) {
    console.log("no servers registered");
    return 0;
  }
  for (const s of cfg.servers) {
    console.log(`  ${s.name}  ${s.url}  [${s.tools.map((t) => t.name).join(", ") || "no tools"}]`);
  }
  return 0;
}

async function cmdStart(): Promise<number> {
  const cfg = loadConfig();
  const server = new HubServer(cfg, AUDIT_PATH);
  await server.listen();
  // hold the event loop; a traded exit() would kill the socket immediately
  await new Promise<void>(() => {});
  return 0;
}

function cmdAudit(n = 20): number {
  if (!existsSync(AUDIT_PATH)) {
    console.log("no audit records yet");
    return 0;
  }
  const lines = readFileSync(AUDIT_PATH, "utf8").trim().split("\n").filter(Boolean).slice(-n);
  for (const line of lines) {
    const e = JSON.parse(line);
    console.log(
      `${e.ts}  ${e.status.padEnd(12)} ${e.tenant.padEnd(8)} ${e.tool.padEnd(20)} ${String(e.latencyMs).padStart(6)}ms  in#${e.inputHash}` +
        (e.error ? `  ${e.error}` : "") +
        (e.requestState ? `  [${e.requestState.slice(0, 8)}]` : ""),
    );
  }
  return 0;
}

async function cmdDoctor(): Promise<number> {
  const cfg = loadConfig();
  if (cfg.servers.length === 0) {
    console.log("nothing to check — add a server first");
    return 0;
  }
  for (const s of cfg.servers) {
    try {
      const base = s.url.endsWith("/") ? s.url : `${s.url}/`;
      const r = await fetch(`${base}mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      });
      if (r.ok) console.log(`  ${s.name}  OK  (${r.status})`);
      else console.log(`  ${s.name}  UPSTREAM ERROR (${r.status})`);
    } catch (err) {
      console.log(`  ${s.name}  UNREACHABLE: ${(err as Error).message}`);
    }
  }
  return 0;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init":
      return cmdInit();
    case "add":
      return cmdAdd(rest);
    case "list":
      return cmdList();
    case "start":
      return cmdStart();
    case "audit":
      return cmdAudit(Number(flag(argv, "--n") ?? 20));
    case "doctor":
      return cmdDoctor();
    case "help":
    case undefined:
      console.log(`
mcp-hub — gateway + registry for a fleet of MCP servers.

  init                 write default config (~/.mcp-hub/config.json)
  add <name> <url>     register a Streamable HTTP upstream
       [--tools a,b]   declare tool names (auto-discovered otherwise)
       [--scopes r,w]
  list                 show registered servers
  start                serve the hub endpoint (127.0.0.1:8801)
  audit [--n 20]       tail the audit log
  doctor               health-check registered upstreams

Talk to it like any MCP client (POST /). Try:
  curl -s :8801 -H 'authorization: Bearer mcp-hub-dev-token' \\
       -H 'content-type: application/json' \\
       -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
`);
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);