// @vitest-environment node
import { POST } from "@/app/api/mcp/route";

vi.mock("@/lib/db", () => ({ default: {} }));
vi.mock("@/lib/mcp/auth", () => ({
  resolveMcpToken: vi.fn(async () => ({
    ok: true,
    userId: "u1",
    tokenName: "bot",
    scopes: ["jobs:write", "jobs:read", "package:write"],
  })),
}));

const COCKPIT_TOOLS = [
  "attach_file",
  "get_job",
  "list_change_requests",
  "list_due_follow_ups",
  "list_jobs",
  "mark_change_request_done",
  "submit_application_package",
  "submit_follow_up",
];

async function listTools(): Promise<string[]> {
  const res = await POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer jsync_test",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  const body = await res.json();
  return body.result.tools.map((t: { name: string }) => t.name);
}

describe("POST /api/mcp tool list vs COCKPIT_ENABLED (AC-13)", () => {
  beforeEach(() => {
    process.env.MCP_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.MCP_ENABLED;
    delete process.env.COCKPIT_ENABLED;
  });

  it.each([undefined, "false", "1"])(
    "flag %s: no cockpit tool is registered",
    async (flag) => {
      if (flag !== undefined) process.env.COCKPIT_ENABLED = flag;
      const names = await listTools();
      expect(names).toContain("add_job");
      expect(names.filter((n) => COCKPIT_TOOLS.includes(n))).toEqual([]);
    },
  );

  it("flag on: the six cockpit tools are added, nothing matches send|approve|reject", async () => {
    process.env.COCKPIT_ENABLED = "true";
    const names = await listTools();
    expect(names.filter((n) => COCKPIT_TOOLS.includes(n)).sort()).toEqual(COCKPIT_TOOLS);
    expect(names.filter((n) => /send|approve|reject/.test(n))).toEqual([]);
  });
});
