// @vitest-environment node

// AC-40 for the send actions: with no session, every export fails closed, makes
// zero prisma calls and never touches Gmail (not even creating the client).
const dbCalls = vi.hoisted(() => [] as string[]);
const gmailCalls = vi.hoisted(() => [] as string[]);

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
vi.mock("@/lib/cockpit/gmail/client", () => ({
  createHttpGmailClient: () => {
    gmailCalls.push("createHttpGmailClient");
    throw new Error("must not be called");
  },
}));

import { getCurrentUser } from "@/utils/user.utils";
import * as actions from "@/actions/cockpitSend.actions";

const exported = Object.entries(actions) as [
  string,
  (...a: unknown[]) => Promise<unknown>,
][];

describe("cockpit send actions with a null user (AC-40)", () => {
  it("covers every export", () => {
    expect(exported.map(([n]) => n).sort()).toEqual([
      "markSendUnknownAsSent",
      "releaseSendLock",
      "sendPackage",
    ]);
  });

  it.each(exported)("%s fails closed: no prisma, no Gmail", async (_n, fn) => {
    vi.stubEnv("COCKPIT_ENABLED", "true");
    dbCalls.length = 0;
    const r = await fn("p1", new Date());
    expect(r).toEqual({
      success: false,
      code: "UNAUTHENTICATED",
      message: "Not authenticated",
    });
    expect(dbCalls).toEqual([]);
    expect(gmailCalls).toEqual([]);
    expect(getCurrentUser).toHaveBeenCalled();
  });

  it.each(exported)("%s with the flag off: COCKPIT_DISABLED, no prisma, no Gmail", async (_n, fn) => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce({ id: "u1" } as never);
    vi.stubEnv("COCKPIT_ENABLED", "false");
    dbCalls.length = 0;
    const r = await fn("p1", new Date());
    expect(r).toMatchObject({ success: false, code: "COCKPIT_DISABLED" });
    expect(dbCalls).toEqual([]);
    expect(gmailCalls).toEqual([]);
  });

  it("an invalid expectedUpdatedAt is VALIDATION before any Gmail client or DB access", async () => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce({ id: "u1" } as never);
    vi.stubEnv("COCKPIT_ENABLED", "true");
    dbCalls.length = 0;
    const r = await actions.sendPackage("p1", "not a date");
    expect(r).toMatchObject({ success: false, code: "VALIDATION" });
    expect(dbCalls).toEqual([]);
    expect(gmailCalls).toEqual([]);
  });
});
