// @vitest-environment node

// The follow-up server actions (D-030): no session or flag off means a failure
// result and zero database access; with a session they call the service with
// that user's id and revalidate constant paths.
const dbCalls = vi.hoisted(() => [] as string[]);
const svc = vi.hoisted(() => ({
  snoozeFollowUp: vi.fn(),
  skipFollowUpStep: vi.fn(),
  stopFollowUps: vi.fn(),
  setFollowUpOutcome: vi.fn(),
  undoFollowUpOutcome: vi.fn(),
}));

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
vi.mock("@/lib/cockpit/followUps", () => svc);

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/utils/user.utils";
import { CockpitError } from "@/lib/cockpit/errors";
import * as actions from "@/actions/cockpitFollowUps.actions";
import { ALLOWED } from "./helpers/actionExports";

const exported = Object.entries(actions) as [string, (...a: unknown[]) => Promise<unknown>][];
const ARGS: Record<string, unknown[]> = {
  snoozeFollowUp: ["job1", 3],
  skipFollowUpStep: ["job1"],
  stopFollowUps: ["job1"],
  setFollowUpOutcome: ["job1", "replied"],
  undoFollowUpOutcome: ["job1"],
};

beforeEach(() => {
  vi.clearAllMocks();
  dbCalls.length = 0;
  vi.mocked(getCurrentUser).mockResolvedValue(null);
});

describe("follow-up actions: exports", () => {
  it("are exactly the allow-listed actions", () => {
    expect(exported.map(([n]) => n).sort()).toEqual([...ALLOWED["cockpitFollowUps.actions.ts"]].sort());
  });
});

describe("follow-up actions without a session or with the flag off", () => {
  it.each(exported)("%s: UNAUTHENTICATED, no prisma, service not called", async (name, fn) => {
    vi.stubEnv("COCKPIT_ENABLED", "true");
    expect(await fn(...ARGS[name])).toEqual({
      success: false,
      code: "UNAUTHENTICATED",
      message: "Not authenticated",
    });
    expect(dbCalls).toEqual([]);
    for (const f of Object.values(svc)) expect(f).not.toHaveBeenCalled();
  });

  it.each(exported)("%s: COCKPIT_DISABLED for a signed-in user, service not called", async (name, fn) => {
    vi.stubEnv("COCKPIT_ENABLED", "false");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u1" } as never);
    expect(await fn(...ARGS[name])).toMatchObject({ success: false, code: "COCKPIT_DISABLED" });
    for (const f of Object.values(svc)) expect(f).not.toHaveBeenCalled();
  });
});

describe("follow-up actions with a session", () => {
  beforeEach(() => {
    vi.stubEnv("COCKPIT_ENABLED", "true");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u1" } as never);
  });

  it("pass the session user id and the arguments to the service, and revalidate constant paths", async () => {
    svc.snoozeFollowUp.mockResolvedValue({ snoozedUntil: null });
    const r = await actions.snoozeFollowUp("job1", 7);
    expect(r).toEqual({ success: true, data: { snoozedUntil: null } });
    expect(svc.snoozeFollowUp).toHaveBeenCalledWith("u1", "job1", 7);
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual(["/dashboard/review", "/dashboard/myjobs"]);

    svc.setFollowUpOutcome.mockResolvedValue({ state: {}, supersededIds: [] });
    await actions.setFollowUpOutcome("job1", "interview");
    expect(svc.setFollowUpOutcome).toHaveBeenCalledWith("u1", "job1", "interview");
    await actions.skipFollowUpStep("job1");
    expect(svc.skipFollowUpStep).toHaveBeenCalledWith("u1", "job1");
    await actions.stopFollowUps("job1");
    expect(svc.stopFollowUps).toHaveBeenCalledWith("u1", "job1");
    await actions.undoFollowUpOutcome("job1");
    expect(svc.undoFollowUpOutcome).toHaveBeenCalledWith("u1", "job1");
  });

  it.each([undefined, null, "", 42, {}])("a bad job id (%j) is VALIDATION and never reaches the service", async (bad) => {
    for (const [name, fn] of exported) {
      const args = [...ARGS[name]];
      args[0] = bad;
      expect(await fn(...args)).toMatchObject({ success: false, code: "VALIDATION" });
    }
    for (const f of Object.values(svc)) expect(f).not.toHaveBeenCalled();
  });

  it("a domain error becomes a fixed-message failure and a state failure revalidates", async () => {
    svc.stopFollowUps.mockRejectedValue(new CockpitError("INVALID_STATE"));
    const r = await actions.stopFollowUps("job1");
    expect(r).toMatchObject({ success: false, code: "INVALID_STATE" });
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("an unexpected error does not leak its text", async () => {
    svc.snoozeFollowUp.mockRejectedValue(new Error("SQLITE: secret path /home/x"));
    const r = await actions.snoozeFollowUp("job1", 3);
    expect(r).toMatchObject({ success: false, code: "INTERNAL" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});
