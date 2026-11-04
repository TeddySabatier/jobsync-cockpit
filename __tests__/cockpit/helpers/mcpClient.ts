import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerCockpitTools,
  type CockpitToolContext,
} from "@/lib/mcp/tools/cockpit";

// A real McpServer + Client over an in-memory transport, so tests go through
// the SDK's shape validation and the registered handlers.
export async function connectCockpit(ctx: CockpitToolContext) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerCockpitTools(server, ctx);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  return {
    client,
    close: () => client.close(),
    async call(name: string, args: Record<string, unknown>) {
      const res = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      return { isError: res.isError === true, text: res.content[0]?.text ?? "" };
    },
  };
}

export const ALL_SCOPES = ["jobs:read", "package:write"];

// Minimal valid PDF-looking payload (synthetic).
export const pdfBase64 = (extra = "") =>
  Buffer.from(`%PDF-1.4\n% synthetic ${extra}\n%%EOF`).toString("base64");
