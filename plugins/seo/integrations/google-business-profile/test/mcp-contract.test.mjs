import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("publica conexión y cinco herramientas de lectura", async () => {
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
        "get_business_profile_location",
        "list_business_profile_accounts",
        "list_business_profile_locations",
        "list_business_profile_reviews",
        "manage_business_profile_connection",
        "query_business_profile_performance",
      ],
    );
    for (const tool of response.tools.filter((item) => item.name !== "manage_business_profile_connection")) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
  } finally {
    await client.close();
  }
});
