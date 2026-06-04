# CORTEX MCP server — drop-in plugin for any agent

`mcp.mjs` is a **zero-dependency** [Model Context Protocol](https://modelcontextprotocol.io) server
that exposes your local CORTEX second-brain to **any MCP-compatible agent** — Claude Desktop, Cursor,
Cline, Continue, and others. No npm install, no API keys. Pure Node (`node:readline` + built-in
`fetch`), talking to the CORTEX HTTP API over MCP's stdio transport.

## Prerequisites

1. **Node.js 18+** (for the global `fetch`). Check with `node --version`.
2. **CORTEX must be running.** The MCP server is just a bridge — it calls the CORTEX HTTP API.

   ```sh
   node workspace/cortex/server.mjs
   ```

   It listens on `http://127.0.0.1:7002`. If the server is down, every tool returns a clear error:
   *"CORTEX server not running at … — start it: node workspace/cortex/server.mjs"* (the bridge never
   crashes your agent).

> **Absolute path matters.** MCP clients spawn the server by command. Use the **absolute** path to
> `mcp.mjs`. On this machine that is:
>
> ```
> C:\Users\User\helm\workspace\cortex\mcp.mjs
> ```
>
> In JSON, escape Windows backslashes (`\\`) **or** use forward slashes (Node accepts both):
> `C:/Users/User/helm/workspace/cortex/mcp.mjs`.

## Tools exposed

| Tool | What it does |
|------|--------------|
| `cortex_capture` | Quick-capture raw text into a note `{ text, tags? }` |
| `cortex_create_note` | Create a titled note `{ title, content?, tags? }` |
| `cortex_search` | Full-text keyword search `{ query }` |
| `cortex_recall` | Semantic search by meaning `{ query }` |
| `cortex_recent` | List recent notes `{ limit? }` |
| `cortex_get` | Get one note by id `{ id }` |
| `cortex_related` | Notes related by meaning to an id `{ id }` |
| `cortex_ask` | Question → source note ids + retrieval context `{ query }` |
| `cortex_projects` | List auto-classified projects `{}` |
| `cortex_tasks` | List open tasks from note checkboxes `{}` |
| `cortex_layers` | The 5-layer stack (Stream/Projects/Areas/Library/Archive) `{}` |

The CORTEX URL defaults to `http://127.0.0.1:7002`; override it with the `CORTEX_URL` env var.

---

## Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Add a `cortex` entry under `mcpServers` (merge with anything already there):

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["C:/Users/User/helm/workspace/cortex/mcp.mjs"],
      "env": {
        "CORTEX_URL": "http://127.0.0.1:7002"
      }
    }
  }
}
```

Fully quit and reopen Claude Desktop. The `cortex_*` tools appear in the tools (hammer) menu.

---

## Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in your project. Same shape:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["C:/Users/User/helm/workspace/cortex/mcp.mjs"],
      "env": {
        "CORTEX_URL": "http://127.0.0.1:7002"
      }
    }
  }
}
```

Reload Cursor (or toggle the server on in **Settings → MCP**).

---

## Cline / Continue / other MCP clients

Any client that speaks MCP over stdio uses the same three keys — `command`, `args`, `env`:

- **Cline** (VS Code): open *Cline → MCP Servers → Configure* and add the `cortex` block to its
  `cline_mcp_settings.json`.
- **Continue:** add it under `mcpServers` in `~/.continue/config.json` (or the YAML equivalent).

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["C:/Users/User/helm/workspace/cortex/mcp.mjs"],
      "env": {
        "CORTEX_URL": "http://127.0.0.1:7002"
      }
    }
  }
}
```

---

## Verify it works (no client needed)

Pipe a JSON-RPC sequence straight into the server and read the responses on stdout:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"cortex_layers","arguments":{}}}' \
  | node workspace/cortex/mcp.mjs
```

You should get three single-line JSON-RPC responses (ids 1, 2, 3). The `notifications/initialized`
line correctly produces **no** response. Diagnostics print to **stderr** and never pollute stdout.

## Troubleshooting

- **Every tool says "CORTEX server not running"** → start CORTEX (`node workspace/cortex/server.mjs`)
  and confirm `http://127.0.0.1:7002/api/health` returns `{ "ok": true }`.
- **Client shows no tools / fails to connect** → check the path in `args` is absolute and correct;
  run the verify command above to confirm the server itself is healthy.
- **Using a non-default port** → set `CORTEX_URL` in the `env` block to match.
- **Logs** → the server writes diagnostics to stderr (prefixed `[cortex-mcp]`); most clients surface
  these in an MCP/output panel.
