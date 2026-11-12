// @vitest-environment node
import fs from "fs";
import path from "path";

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "u1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/telemetry", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  default: {
    applicationPackage: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    gmailAccount: { findUnique: vi.fn() },
    job: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import prisma from "@/lib/db";
import { log } from "@/lib/telemetry";
import { COCKPIT_ERROR_MESSAGES } from "@/lib/cockpit/errors";
import * as actions from "@/actions/cockpit.actions";

// AC-49 (actions part).
describe("result shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("COCKPIT_ENABLED", "true");
  });

  it("an unexpected DB error yields INTERNAL with the generic message, no leak", async () => {
    const leak = "Invalid `prisma.applicationPackage.findFirst()` DISTINCTIVE-9137";
    vi.mocked(prisma.applicationPackage.findFirst).mockRejectedValue(
      new Error(leak),
    );
    const r = await actions.approvePackage("p1");
    expect(r).toEqual({
      success: false,
      code: "INTERNAL",
      message: COCKPIT_ERROR_MESSAGES.INTERNAL,
    });
    const logged = JSON.stringify(vi.mocked(log.error).mock.calls);
    expect(JSON.stringify(r)).not.toContain("DISTINCTIVE");
    expect(logged).not.toContain("DISTINCTIVE");
  });

  it("success is { success: true, data }", async () => {
    vi.mocked(prisma.applicationPackage.findMany).mockResolvedValue([]);
    vi.mocked(prisma.applicationPackage.count).mockResolvedValue(0);
    vi.mocked(prisma.gmailAccount.findUnique).mockResolvedValue(null);
    const r = await actions.getReviewQueue("todo");
    expect(Object.keys(r).sort()).toEqual(["data", "success"]);
  });

  it("no cockpit action or route file imports handleError", () => {
    for (const f of [
      "src/actions/cockpit.actions.ts",
      "src/app/api/cockpit/files/[packageId]/route.ts",
    ]) {
      expect(
        fs.readFileSync(path.join(process.cwd(), f), "utf8"),
      ).not.toContain("handleError");
    }
  });
});
