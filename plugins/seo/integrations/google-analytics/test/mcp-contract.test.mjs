import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("el servidor publica exactamente las cinco herramientas previstas", async () => {
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({ command: "node", args: ["./mcp/server.mjs"], cwd: pluginRoot, stderr: "pipe" });
  const client = new Client({ name: "plugin-contract-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const response = await client.listTools();
    assert.deepEqual(response.tools.map((tool) => tool.name).sort(), [
      "get_analytics_metadata",
      "list_analytics_properties",
      "manage_analytics_connection",
      "run_analytics_realtime_report",
      "run_analytics_report",
    ]);
    for (const tool of response.tools.filter((item) => item.name !== "manage_analytics_connection")) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
  } finally { await client.close(); }
});
