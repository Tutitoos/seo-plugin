import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("el servidor publica exactamente las cinco herramientas previstas", async () => {
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["./mcp/server.mjs"],
    cwd: pluginRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "plugin-contract-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const response = await client.listTools();
    assert.deepEqual(
      response.tools.map((tool) => tool.name).sort(),
      [
        "inspect_search_console_url",
        "list_search_console_sitemaps",
        "list_search_console_sites",
        "manage_google_connection",
        "query_search_performance",
      ],
    );
    for (const tool of response.tools.filter((item) => item.name !== "manage_google_connection")) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
  } finally {
    await client.close();
  }
});
