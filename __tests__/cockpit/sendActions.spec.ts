// @vitest-environment node

vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/telemetry", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/cockpit/gmail/client", () => ({
  createHttpGmailClient: vi.fn(() => ({})),
}));
vi.mock("@/lib/cockpit/send", () => ({
  sendApplicationPackage: vi.fn(),
  markSendUnknownAsSent: vi.fn(),
  releaseSendLock: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/utils/user.utils";
import * as send from "@/lib/cockpit/send";
import { CockpitError } from "@/lib/cockpit/errors";
import * as actions from "@/actions/cockpitSend.actions";

const m = (f: unknown) => f as ReturnType<typeof vi.fn>;
const revalidated = () => m(revalidatePath).mock.calls.map(([p]) => p);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("COCKPIT_ENABLED", "true");
  m(getCurrentUser).mockResolvedValue({ id: "u1" });
});
afterEach(() => vi.unstubAllEnvs());

const calls: [string, () => Promise<unknown>, ReturnType<typeof vi.fn>][] = [
  ["sendPackage", () => actions.sendPackage("p1", new Date()), m(send.sendApplicationPackage)],
  ["markSendUnknownAsSent", () => actions.markSendUnknownAsSent("p1"), m(send.markSendUnknownAsSent)],
  ["releaseSendLock", () => actions.releaseSendLock("p1"), m(send.releaseSendLock)],
];

describe.each(calls)("%s", (_n, call, service) => {
  it("revalidates the review pages and the job list on success", async () => {
    service.mockResolvedValue({ id: "p1" });
    expect(await call()).toMatchObject({ success: true });
    expect(revalidated()).toEqual(
      expect.arrayContaining([
        "/dashboard/review",
        "/dashboard/review/p1",
        "/dashboard/myjobs",
      ]),
    );
  });

  it.each(["CONFLICT", "INVALID_STATE", "SEND_OUTCOME_UNKNOWN"] as const)(
    "revalidates after a %s failure",
    async (code) => {
      service.mockRejectedValue(new CockpitError(code));
      expect(await call()).toMatchObject({ success: false, code });
      expect(revalidated()).toEqual(
        expect.arrayContaining(["/dashboard/review/p1", "/dashboard/myjobs"]),
      );
    },
  );

  it("does not revalidate for an anonymous caller or with the flag off", async () => {
    m(getCurrentUser).mockResolvedValue(null);
    expect(await call()).toMatchObject({ code: "UNAUTHENTICATED" });
    m(getCurrentUser).mockResolvedValue({ id: "u1" });
    vi.stubEnv("COCKPIT_ENABLED", "false");
    expect(await call()).toMatchObject({ code: "COCKPIT_DISABLED" });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
  });
});

describe("sendPackage expectedUpdatedAt", () => {
  it.each([null, undefined, 0, 1730000000000, {}, [], true])(
    "%j is VALIDATION, not an epoch-date CONFLICT; the service is not called",
    async (bad) => {
      const r = await actions.sendPackage("p1", bad as never);
      expect(r).toMatchObject({ success: false, code: "VALIDATION" });
      expect(send.sendApplicationPackage).not.toHaveBeenCalled();
    },
  );

  it("an unparseable string is VALIDATION", async () => {
    expect(await actions.sendPackage("p1", "not a date")).toMatchObject({
      code: "VALIDATION",
    });
    expect(send.sendApplicationPackage).not.toHaveBeenCalled();
  });

  it("a Date and an ISO string both reach the service as the same Date", async () => {
    m(send.sendApplicationPackage).mockResolvedValue({ id: "p1" });
    const iso = "2026-11-01T10:00:00.000Z";
    await actions.sendPackage("p1", new Date(iso));
    await actions.sendPackage("p1", iso);
    const [first, second] = m(send.sendApplicationPackage).mock.calls;
    expect(first[2]).toEqual(new Date(iso));
    expect(second[2]).toEqual(new Date(iso));
  });
});
