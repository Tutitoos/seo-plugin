import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const servers = [
  ["seo-workspace", "./src/mcp-server.mjs", 12],
  ["google-analytics", "./integrations/google-analytics/mcp/server.mjs", 5],
  ["google-search-console", "./integrations/google-search-console/mcp/server.mjs", 5],
  ["google-business-profile", "./integrations/google-business-profile/mcp/server.mjs", 6],
];
const all = [];
for (const [name, script, count] of servers) {
  const transport = new StdioClientTransport({ command: "node", args: [script], cwd: process.cwd(), stderr: "pipe" });
  const client = new Client({ name: "seo-plugin-smoke", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    if (tools.length !== count) throw new Error(`${name}: se esperaban ${count} herramientas y se encontraron ${tools.length}.`);
    all.push(...tools);
  } finally { await client.close(); }
}
if (new Set(all).size !== 28) throw new Error("Hay nombres de herramientas duplicados.");
console.log(JSON.stringify({ count: all.length, tools: all }, null, 2));
