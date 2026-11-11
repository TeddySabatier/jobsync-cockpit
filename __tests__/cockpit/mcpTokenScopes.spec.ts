// @vitest-environment node
import prisma from "@/lib/db";
import { createMcpToken } from "@/actions/mcpToken.actions";
import { COCKPIT_SCOPES } from "@/lib/cockpit/config";

vi.mock("@/lib/db", () => ({
  default: {
    mcpAccessToken: { count: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/actions/shared", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));

const db = prisma as unknown as {
  mcpAccessToken: {
    count: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

describe("createMcpToken default scopes (AC-10)", () => {
  afterEach(() => {
    delete process.env.COCKPIT_ENABLED;
  });

  // Same expectation for every flag value on purpose: scopes do not depend on
  // COCKPIT_ENABLED. Expiry and malformed scopes are covered by
  // __tests__/mcpAuth.spec.ts (resolveMcpToken).
  it.each([undefined, "false", "true"])(
    "grants all five scopes regardless of the flag (COCKPIT_ENABLED=%s)",
    async (flag) => {
      if (flag !== undefined) process.env.COCKPIT_ENABLED = flag;
      db.mcpAccessToken.count.mockResolvedValue(0);
      db.mcpAccessToken.create.mockImplementation(async ({ data }) => ({
        id: "t1",
        ...data,
        lastUsedAt: null,
        createdAt: new Date(),
      }));

      const res = await createMcpToken({ name: "bot", expiryDays: 30 });

      expect(res.success).toBe(true);
      const stored = JSON.parse(db.mcpAccessToken.create.mock.calls[0][0].data.scopes);
      expect(stored).toEqual([
        "jobs:write",
        "questions:write",
        "resume:write",
        "jobs:read",
        "package:write",
      ]);
      expect(stored).toEqual(expect.arrayContaining([...COCKPIT_SCOPES]));
    },
  );
});
