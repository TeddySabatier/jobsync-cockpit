// @vitest-environment node

// AC-40: with no session, every exported action/query returns a failure and
// touches the database zero times (a recording deep proxy replaces prisma).
const dbCalls = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/db", () => {
  const make = (name: string): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => make(`${name}.${String(prop)}`),
      apply: () => {
        dbCalls.push(name);
        return Promise.resolve(null);
      },
    });
  return { default: make("prisma") };
});
vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/telemetry", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getCurrentUser } from "@/utils/user.utils";
import * as actions from "@/actions/cockpit.actions";

const exported = Object.entries(actions) as [string, (...a: unknown[]) => Promise<unknown>][];

describe("cockpit actions with a null user (AC-40)", () => {
  it("covers every export", () => {
    expect(exported.length).toBe(9);
  });

  it.each(exported)("%s fails and does not touch prisma", async (_n, fn) => {
    vi.stubEnv("COCKPIT_ENABLED", "true");
    dbCalls.length = 0;
    const r = await fn("p1", "x", "x");
    expect(r).toEqual({
      success: false,
      code: "UNAUTHENTICATED",
      message: "Not authenticated",
    });
    expect(dbCalls).toEqual([]);
    expect(getCurrentUser).toHaveBeenCalled();
  });

  it("also fails closed when getCurrentUser throws", async () => {
    vi.mocked(getCurrentUser).mockRejectedValueOnce(new Error("db down: secret"));
    dbCalls.length = 0;
    const r = await actions.approvePackage("p1");
    expect(r).toMatchObject({ success: false, code: "INTERNAL" });
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(dbCalls).toEqual([]);
  });
});
