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
    expect(limiter).toHaveBeenCalledWith("u1", COCKPIT_RATE_LIMITS.cockpit);
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

  it("consumes cockpit then cockpit-attach", async () => {
    // Denied on the second check: RATE_LIMITED, both buckets consulted in order.
    limiter.mockReturnValueOnce(allow).mockReturnValueOnce(deny);
    const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: ALL_SCOPES });
    expect(await c.call("attach_file", args)).toEqual({
      isError: true,
      text: text("RATE_LIMITED"),
    });
    expect(limiter.mock.calls).toEqual([
      ["u1", COCKPIT_RATE_LIMITS.cockpit],
      ["u1", COCKPIT_RATE_LIMITS.attach],
    ]);
    await c.close();
  });

  it("does not consume cockpit-attach when the cockpit bucket denies", async () => {
    limiter.mockReturnValueOnce(deny);
    const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: ALL_SCOPES });
    await c.call("attach_file", args);
    expect(limiter).toHaveBeenCalledTimes(1);
    await c.close();
  });

  it("other tools never touch the cockpit-attach bucket", async () => {
    const c = await connectCockpit({ userId: "u1", tokenName: "bot", scopes: ALL_SCOPES });
    await c.call("list_jobs", {});
    expect(limiter.mock.calls).toEqual([["u1", COCKPIT_RATE_LIMITS.cockpit]]);
    await c.close();
  });
});
