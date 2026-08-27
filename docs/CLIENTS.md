# Client Configuration

One hub endpoint, every MCP client. All snippets assume the hub is running on
`127.0.0.1:8801` with a tenant token. Replace the token and host as needed.

## Claude Code

```bash
claude mcp add hub \
  --transport http \
  --url http://127.0.0.1:8801 \
  --header "Authorization: Bearer mcp-hub-dev-token"
```

## Cursor

`Settings` → `Experimental` → `MCP` → `Add new MCP server`:

```json
{
  "mcpServers": {
    "hub": {
      "url": "http://127.0.0.1:8801",
      "headers": { "Authorization": "Bearer mcp-hub-dev-token" }
    }
  }
}
```

## Zed

`.zed/settings.json` in any project, or `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "hub": {
      "command": "curl",
      "args": [
        "-s",
        "-H", "Authorization: Bearer mcp-hub-dev-token",
        "-H", "Content-Type: application/json",
        "http://127.0.0.1:8801"
      ],
      "env": {}
    }
  }
}
```

Zed talks stdio, so the hub can sit behind a thin stdio→HTTP shim. The curl
bridge above is deliberately simple; for a real shim, pipe JSON-RPC frames.

## VS Code (Copilot) / Cline / Continue

Most use a `mcp.json` or settings block like:

```json
{
  "mcpServers": {
    "hub": {
      "type": "http",
      "url": "http://127.0.0.1:8801",
      "headers": { "Authorization": "Bearer mcp-hub-dev-token" }
    }
  }
}
```

## Gemini CLI

```bash
gemini config set mcpServers.hub.url http://127.0.0.1:8801
gemini config set mcpServers.hub.headers.Authorization "Bearer mcp-hub-dev-token"
```

## Verification

```bash
mcp-hub doctor          # upstreams healthy
curl -s http://127.0.0.1:8801/health
mcp-hub audit --n 20    # watch calls land as you ping tools from your client
```

If your client does not speak Streamable HTTP (stdio-only hosts), run one of the
stdio bridge adapters against the hub — the hub upstream side stays HTTP either
way.