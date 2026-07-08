# AgentBridge Booking Demo

A booking/reservation app that AI agents can operate via **AgentBridge** — a developer SDK layered on the [WebMCP](https://webmachinelearning.github.io/webmcp/) browser standard.

The same six operations are exposed through two surfaces from a single shared registry:

| Surface | How agents connect | URL |
|---|---|---|
| MCP Streamable HTTP | Claude Desktop, Claude Code, MCP Inspector | `http://localhost:3000/api/mcp` |
| In-page WebMCP | Browser console / in-page agents | `document.modelContext` |

## Quick Start

```bash
npm install
npm run dev
# Open http://localhost:3000
```

> **Note:** State is in-memory — resets on server restart.

## Connect Claude Code

```bash
claude mcp add --transport http booking http://localhost:3000/api/mcp
```

Or add to your `.mcp.json`:
```json
{
  "mcpServers": {
    "booking": { "type": "http", "url": "http://localhost:3000/api/mcp" }
  }
}
```

Then ask Claude: *"Book me a table for 2 tomorrow evening"*

## Connect Claude Desktop

Settings → Connectors → Add custom connector → enter `http://localhost:3000/api/mcp`

## MCP Inspector

```bash
npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp
```

## In-page WebMCP (browser console)

```javascript
// List all tools (WebMCP standard API)
document.modelContext.getTools().map(t => t.name)

// Use the AgentBridge SDK (higher-level)
agentBridge.describe()
await agentBridge.call("searchAvailability", { date: "2026-07-09", partySize: 2 })
await agentBridge.call("createReservation", { slotId: "<id>", name: "Alice", partySize: 2 })
// cancelReservation triggers the confirmation dialog:
await agentBridge.call("cancelReservation", { reservationId: "<id>", confirm: true })
```

## Available Operations

| Name | Permission | Requires Confirmation |
|---|---|---|
| `searchAvailability` | read | No |
| `listReservations` | read | No |
| `getReservation` | read | No |
| `createReservation` | write | No |
| `cancelReservation` | write | **Yes** |
| `getContext` | read | No |

## Architecture

```
lib/operations/          ← single source of truth for all operations
  types.ts               ← Operation descriptor type + defineOperation helper
  index.ts               ← registry array
  *.ts                   ← one file per operation

lib/adapters/
  mcp.ts                 ← maps registry → MCP tools (McpServer.registerTool)
  webmcp.ts              ← maps registry → in-page document.modelContext

app/api/[transport]/
  route.ts               ← MCP Streamable HTTP endpoint (mcp-handler)

lib/agentbridge.ts       ← AgentBridge SDK (register, call, describe, subscribe…)
lib/webmcp-polyfill.ts   ← document.modelContext shim for browsers without WebMCP
lib/store.ts             ← in-memory reservation state + event emitter
lib/auditlog.ts          ← audit log (shown in UI, records agent + UI calls)
```
