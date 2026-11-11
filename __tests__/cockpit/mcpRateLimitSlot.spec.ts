// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { checkMcpRateLimit } from "@/lib/mcp/rate-limit";
import { ALL_SCOPES, connectCockpit, pdfBase64 } from "./helpers/mcpClient";

// Real rate limiter (not mocked): proves the slots actually spent.
vi.mock("@/lib/db", () => ({
  default: new Proxy({}, { get() { throw new Error("DB touched"); } }),
}));
const uploads = vi.hoisted(() => ({ dir: "" }));
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
vi.mock("@/lib/cockpit/config", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/cockpit/config")>();
  return {
    ...mod,
    COCKPIT_RATE_LIMITS: {
      cockpit: { bucket: "cockpit", max: 10, windowMs: 3_600_000 },
      attach: { bucket: "cockpit-attach", max: 2, windowMs: 3_600_000 },
    },
  };
});
vi.mock("@/lib/telemetry", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeAll(() => {
  uploads.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-slot-"));
});
afterAll(() => fs.rmSync(uploads.dir, { recursive: true, force: true }));

describe("rate-limit slots of attach_file", () => {
  it("a call refused by the attach bucket does not spend a cockpit slot", async () => {
    const c = await connectCockpit({ userId: "slot-u", tokenName: "bot", scopes: ALL_SCOPES });
    const args = { fileName: "a.pdf", mimeType: "application/pdf", contentBase64: pdfBase64() };
    // Two allowed (they fail at the DB: INTERNAL), then the attach bucket refuses.
    await c.call("attach_file", args);
    await c.call("attach_file", args);
    for (let i = 0; i < 3; i++) {
      expect((await c.call("attach_file", args)).text).toMatch(/^RATE_LIMITED/);
    }
    await c.close();
    // 10 max, 2 spent by the allowed calls: 8 left, not 5.
    const peek = checkMcpRateLimit("slot-u", {
      bucket: "cockpit",
      max: 10,
      windowMs: 3_600_000,
      peek: true,
    });
    expect(peek.remaining).toBe(8);
  });
});
