// Ad-hoc MCP client for manual benchmark testing. Not part of the app.
// Usage: node scripts/mcp-client.mjs <token> '<json-array-of-{method,params}>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = process.argv[2];
const calls = process.argv[3] === "--list" ? null : JSON.parse(process.argv[3]);

const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:3000/api/mcp"),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
);

const client = new Client({ name: "bench-client", version: "1.0.0" });
await client.connect(transport);

if (calls === null) {
  const tools = await client.listTools();
  console.log(JSON.stringify(tools, null, 2));
  await client.close();
  process.exit(0);
}

const results = [];
for (const call of calls) {
  const start = Date.now();
  try {
    const res = await client.callTool({ name: call.name, arguments: call.arguments ?? {} });
    results.push({ name: call.name, arguments: call.arguments, ms: Date.now() - start, result: res });
  } catch (err) {
    results.push({ name: call.name, arguments: call.arguments, ms: Date.now() - start, error: String(err) });
  }
}

console.log(JSON.stringify({ serverInfo: client.getServerVersion(), instructions: client.getInstructions?.(), results }, null, 2));
await client.close();
