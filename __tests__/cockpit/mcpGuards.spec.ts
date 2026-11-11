// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { checkMcpRateLimit } from "@/lib/mcp/rate-limit";
import { COCKPIT_ERROR_MESSAGES } from "@/lib/cockpit/errors";
import { COCKPIT_RATE_LIMITS } from "@/lib/cockpit/config";
import { ALL_SCOPES, connectCockpit, pdfBase64 } from "./helpers/mcpClient";

// Any DB access throws: reaching it means a guard did not stop the call first.
vi.mock("@/lib/db", () => ({
  default: new Proxy(
    {},
    {
      get() {
        throw new Error("DB touched: secret-prisma-detail");
      },
    },
  ),
}));
const uploads = vi.hoisted(() => ({ dir: "" }));
// attach_file writes the file before the DB row: keep that out of ./data.
vi.mock("@/lib/constants", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/constants")>();
  return {
    ...mod,
    APP_CONSTANTS: {
      ...mod.APP_CONSTANTS,
      get UPLOADS_DIR() {
        return uploads.dir;
      },
    },
  };
});
vi.mock("@/lib/mcp/rate-limit", () => ({ checkMcpRateLimit: vi.fn() }));
vi.mock("@/lib/telemetry", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const limiter = vi.mocked(checkMcpRateLimit);
const allow = { allowed: true, remaining: 1, resetIn: 1 };
const deny = { allowed: false, remaining: 0, resetIn: 1000 };

const text = (code: keyof typeof COCKPIT_ERROR_MESSAGES) =>
  `${code}: ${COCKPIT_ERROR_MESSAGES[code]}`;

// One valid call per tool, with the scope it needs.
const CALLS: Array<[string, string, Record<string, unknown>]> = [
  [
    "attach_file",
    "package:write",
    { fileName: "a.pdf", mimeType: "application/pdf", contentBase64: pdfBase64() },
  ],
  [
    "submit_application_package",
    "package:write",
    { jobId: "j1", emailSubject: "s", emailBody: "b", fitGrade: "A" },
  ],
  ["list_jobs", "jobs:read", {}],
  ["get_job", "jobs:read", { jobId: "j1" }],
  ["list_change_requests", "jobs:read", {}],
  ["mark_change_request_done", "package:write", { packageId: "p1", response: "Done" }],
];

beforeAll(() => {
  uploads.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-guards-"));
});
afterAll(() => fs.rmSync(uploads.dir, { recursive: true, force: true }));

beforeEach(() => {
  limiter.mockReset();
  limiter.mockReturnValue(allow);
});

describe.each(CALLS)("%s", (tool, scope, args) => {
  it(`rejects a token without ${scope}, before rate limit and DB (AC-09)`, async () => {
    const other = ALL_SCOPES.filter((s) => s !== scope);
    for (const scopes of [[], other, ["jobs:write", "questions:write", "resume:write"]]) {
      const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes });
      expect(await c.call(tool, args)).toEqual({
        isError: true,
        text: text("UNAUTHORIZED_SCOPE"),
      });
      await c.close();
    }
    expect(limiter).not.toHaveBeenCalled();
  });

  it("returns RATE_LIMITED when the cockpit bucket is exhausted, before the DB (AC-50)", async () => {
    limiter.mockReturnValue(deny);
    const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: ALL_SCOPES });
    expect(await c.call(tool, args)).toEqual({ isError: true, text: text("RATE_LIMITED") });
    // attach_file consults its own bucket first (peek), the others cockpit.
    expect(limiter).toHaveBeenCalledWith(
      "u1",
      tool === "attach_file"
        ? { ...COCKPIT_RATE_LIMITS.attach, peek: true }
        : COCKPIT_RATE_LIMITS.cockpit,
    );
    await c.close();
  });

  it("hides unexpected error text behind INTERNAL (AC-46)", async () => {
    const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: ALL_SCOPES });
    const res = await c.call(tool, args);
    expect(res).toEqual({ isError: true, text: text("INTERNAL") });
    expect(res.text).not.toContain("secret-prisma-detail");
    await c.close();
  });
});

describe("attach_file buckets", () => {
  const args = CALLS[0][2];
  const A = COCKPIT_RATE_LIMITS.attach;
  const C = COCKPIT_RATE_LIMITS.cockpit;

  it("peeks cockpit-attach, then spends cockpit, then cockpit-attach", async () => {
    const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: ALL_SCOPES });
    await c.call("attach_file", args);
    expect(limiter.mock.calls).toEqual([
      ["u1", { ...A, peek: true }],
      ["u1", C],
      ["u1", A],
    ]);
    await c.close();
  });

  it("a call refused by cockpit-attach spends no slot at all", async () => {
    limiter.mockImplementation((_u, o) => (o?.bucket === A.bucket ? deny : allow));
    const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: ALL_SCOPES });
    expect(await c.call("attach_file", args)).toEqual({
      isError: true,
      text: text("RATE_LIMITED"),
    });
    expect(limiter.mock.calls.filter(([, o]) => !o?.peek)).toEqual([]);
    await c.close();
  });

  it("does not spend cockpit-attach when the cockpit bucket denies", async () => {
    limiter.mockImplementation((_u, o) => (o?.bucket === C.bucket ? deny : allow));
    const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: ALL_SCOPES });
    await c.call("attach_file", args);
    expect(limiter.mock.calls.filter(([, o]) => !o?.peek && o?.bucket === A.bucket)).toEqual([]);
    await c.close();
  });

  it("other tools never touch the cockpit-attach bucket", async () => {
    const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: ALL_SCOPES });
    await c.call("list_jobs", {});
    expect(limiter.mock.calls).toEqual([["u1", C]]);
    await c.close();
  });
});

describe("argument errors (finding: SDK validates the shape first)", () => {
  it("a token without the scope and bad arguments gets the SDK's shape error, not a cockpit code, and no rate-limit slot", async () => {
    const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: [] });
    const res = await c.call("list_jobs", { limit: 0 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^MCP error -32602: Input validation error/);
    expect(res.text).not.toMatch(/UNAUTHORIZED_SCOPE|VALIDATION:/);
    await c.close();
    expect(limiter).not.toHaveBeenCalled();
  });

  it("a scoped token with a bad enum gets the same SDK error, not VALIDATION", async () => {
    const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: ALL_SCOPES });
    const res = await c.call("submit_application_package", {
      jobId: "j",
      emailSubject: "s",
      emailBody: "b",
      fitGrade: "C",
    });
    expect(res.text).toMatch(/^MCP error -32602: Input validation error/);
    expect(res.text).not.toMatch(/^VALIDATION:/);
    await c.close();
  });

  it("a token without the scope and valid arguments still gets UNAUTHORIZED_SCOPE", async () => {
    const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: [] });
    expect(await c.call("list_jobs", { limit: 5 })).toEqual({
      isError: true,
      text: text("UNAUTHORIZED_SCOPE"),
    });
    await c.close();
  });

  it.each(CALLS.map(([tool]) => tool))(
    "%s: an unscoped token with a malformed argument gets the SDK shape error and spends no slot",
    async (tool) => {
      limiter.mockClear();
      const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: [] });
      const res = await c.call(tool, { jobId: 42, packageId: 42, limit: "x", fileName: 1 });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/^MCP error -32602: Input validation error/);
      await c.close();
      expect(limiter).not.toHaveBeenCalled();
    },
  );
});
