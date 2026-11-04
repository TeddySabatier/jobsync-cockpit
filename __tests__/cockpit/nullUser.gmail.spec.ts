// @vitest-environment node

// AC-40: with no session, every Gmail action and the settings page fail and
// touch the database zero times.
const dbCalls = vi.hoisted(() => [] as string[]);
const redirectMock = vi.hoisted(() => vi.fn());

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
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirectMock(to);
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import * as actions from "@/actions/cockpitGmail.actions";
import ReviewSettingsPage from "@/app/dashboard/review/settings/page";

const exported = Object.entries(actions) as [string, (...a: unknown[]) => Promise<unknown>][];
const fetchMock = vi.fn();

describe("Gmail actions with a null user (AC-40)", () => {
  beforeEach(() => {
    vi.stubEnv("COCKPIT_ENABLED", "true");
    vi.stubGlobal("fetch", fetchMock);
    dbCalls.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("covers every export", () => {
    expect(exported.map(([n]) => n).sort()).toEqual(["disconnectGmail", "getGmailSettings"]);
  });

  it.each(exported)("%s fails without touching prisma or Google", async (_n, fn) => {
    expect(await fn()).toEqual({
      success: false,
      code: "UNAUTHENTICATED",
      message: "Not authenticated",
    });
    expect(dbCalls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the settings page redirects to sign-in and renders nothing", async () => {
    await expect(
      ReviewSettingsPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectMock).toHaveBeenCalledWith("/signin");
    expect(dbCalls).toEqual([]);
  });

  it("flag off: the actions fail with COCKPIT_DISABLED only after auth, still no write", async () => {
    const { getCurrentUser } = await import("@/utils/user.utils");
    vi.mocked(getCurrentUser).mockResolvedValueOnce({ id: "u1", name: "", email: "" });
    vi.stubEnv("COCKPIT_ENABLED", "false");
    expect(await actions.disconnectGmail()).toMatchObject({ success: false, code: "COCKPIT_DISABLED" });
    expect(dbCalls).toEqual([]);
  });
});
