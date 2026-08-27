import { HubConfig, ServerDef, TenantConfig, ToolDef } from "./types.js";

export class Registry {
  constructor(private cfg: HubConfig) {}

  server(name: string): ServerDef | undefined {
    return this.cfg.servers.find((s) => s.name === name);
  }

  tenant(id: string): TenantConfig | undefined {
    return this.cfg.tenants.find((t) => t.id === id);
  }

  tool(serverName: string, toolName: string): ToolDef | undefined {
    return this.server(serverName)?.tools.find((t) => t.name === toolName);
  }

  serverForTool(toolName: string): { server: ServerDef; tool: ToolDef } | undefined {
    for (const s of this.cfg.servers) {
      const tool = s.tools.find((t) => t.name === toolName);
      if (tool) return { server: s, tool };
    }
    return undefined;
  }

  allTools(): { server: ServerDef; tool: ToolDef }[] {
    const out: { server: ServerDef; tool: ToolDef }[] = [];
    for (const s of this.cfg.servers) for (const t of s.tools) out.push({ server: s, tool: t });
    return out;
  }

  toolCount(): number {
    return this.allTools().length;
  }
}