// @vitest-environment node
// Extra proofs for PR #71 (issue #57): gaps found by mutation testing.

vi.mock("@/lib/db", () => ({
  default: { gmailAccount: { findUnique: vi.fn(), deleteMany: vi.fn() } },
}));
vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/telemetry", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { revalidatePath } from "next/cache";
import prisma from "@/lib/db";
import { getCurrentUser } from "@/utils/user.utils";
import { RequireUserError } from "@/lib/authError";
import { requireUser } from "@/actions/shared";
import { isGmailSendAllowed } from "@/lib/cockpit/config";
import { mutate, reviewPaths, run } from "@/lib/cockpit/actionRunner";
import { toPackageView } from "@/lib/cockpit/packageView";
import { disconnectGmail } from "@/actions/cockpitGmail.actions";

const m = (f: unknown) => f as ReturnType<typeof vi.fn>;
const revalidated = () => m(revalidatePath).mock.calls.map(([p]) => p);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("COCKPIT_ENABLED", "true");
  m(getCurrentUser).mockResolvedValue({ id: "u1" });
  m(prisma.gmailAccount.findUnique).mockResolvedValue(null);
  m(prisma.gmailAccount.deleteMany).mockResolvedValue({ count: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("disconnectGmail revalidation (shared mutate)", () => {
  const both = ["/dashboard/review", "/dashboard/review/settings"];

  it("revalidates the review list and the settings page on success", async () => {
    expect(await disconnectGmail()).toMatchObject({ success: true });
    expect(revalidated()).toEqual(both);
  });

  it("still revalidates when the delete fails (INTERNAL)", async () => {
    m(prisma.gmailAccount.deleteMany).mockRejectedValue(new Error("db down"));
    expect(await disconnectGmail()).toMatchObject({ success: false, code: "INTERNAL" });
    expect(revalidated()).toEqual(both);
  });

  it("does not revalidate for an anonymous caller or with the flag off", async () => {
    m(getCurrentUser).mockResolvedValue(null);
    expect(await disconnectGmail()).toMatchObject({ code: "UNAUTHENTICATED" });
    m(getCurrentUser).mockResolvedValue({ id: "u1" });
    vi.stubEnv("COCKPIT_ENABLED", "false");
    expect(await disconnectGmail()).toMatchObject({ code: "COCKPIT_DISABLED" });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(prisma.gmailAccount.findUnique).not.toHaveBeenCalled();
  });
});

describe("actionRunner", () => {
  it("run: the anonymous caller is UNAUTHENTICATED and fn never runs", async () => {
    m(getCurrentUser).mockResolvedValue(null);
    const fn = vi.fn();
    expect(await run(fn)).toMatchObject({ success: false, code: "UNAUTHENTICATED" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("run: auth is checked before the flag", async () => {
    m(getCurrentUser).mockResolvedValue(null);
    vi.stubEnv("COCKPIT_ENABLED", "false");
    expect(await run(vi.fn())).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("mutate: revalidates every given path after a non-auth failure, none after auth/flag", async () => {
    const boom = async () => {
      throw new Error("x");
    };
    expect(await mutate(["/a", "/b"], boom)).toMatchObject({ code: "INTERNAL" });
    expect(revalidated()).toEqual(["/a", "/b"]);
    m(revalidatePath).mockClear();
    vi.stubEnv("COCKPIT_ENABLED", "false");
    await mutate(["/a"], boom);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reviewPaths adds the job list only on request", () => {
    expect(reviewPaths("p1")).toEqual(["/dashboard/review", "/dashboard/review/p1"]);
    expect(reviewPaths("p1", { jobs: true })).toEqual([
      "/dashboard/review",
      "/dashboard/review/p1",
      "/dashboard/myjobs",
    ]);
  });
});

describe("RequireUserError", () => {
  it("requireUser throws a typed RequireUserError that keeps the legacy message", async () => {
    m(getCurrentUser).mockResolvedValue(null);
    const e = await requireUser().catch((x) => x);
    expect(e).toBeInstanceOf(RequireUserError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RequireUserError");
    expect(e.message).toBe("Not authenticated");
  });
});

describe("isGmailSendAllowed", () => {
  it.each([
    ["you@example.com", "you@example.com", true],
    ["  You@Example.COM ", " you@EXAMPLE.com  ", true],
    ["other@example.com", "you@example.com", false],
    ["you@example.com", "", false],
    ["you@example.com", "   ", false],
    ["you@example.com", undefined, false],
    ["", "you@example.com", false],
    [null, "you@example.com", false],
    [undefined, "you@example.com", false],
    [undefined, undefined, false],
  ])("account %j, allow-list %j -> %s", (account, allowList, expected) => {
    if (allowList === undefined) vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", undefined as never);
    else vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", allowList);
    expect(isGmailSendAllowed(account as string | null | undefined)).toBe(expected);
  });
});

describe("toPackageView", () => {
  const row = {
    id: "p1",
    version: 1,
    status: "pending",
    emailTo: null,
    emailSubject: "s",
    emailBody: "b",
    letterMd: null,
    fitGrade: null,
    fitAnalysis: null,
    cvJson: null,
    cvFileId: null,
    cvPdfStale: false,
    rejectReason: null,
    changeRequest: null,
    changeRequestedAt: null,
    changeRequestResponse: null,
    sendStartedAt: null,
    sendOutcome: null,
    updatedAt: new Date(0),
    job: {
      id: "j1",
      jobUrl: null,
      description: "d",
      JobTitle: { label: "T", id: "x", createdBy: "u" },
      Company: { label: "C", id: "y", createdBy: "u" },
    },
  };

  it("exposes exactly the fields the review UI reads, even from a fuller row", () => {
    const full = {
      ...row,
      userId: "u1",
      jobId: "j1",
      idempotencyKey: "K",
      sourceFolder: "F",
      approvedAt: new Date(),
      sentAt: new Date(),
      cvFile: { filePath: "/x" },
      job: { ...row.job, userId: "u1", salaryRange: "SECRET", jobType: "x" },
    };
    const v = toPackageView(full);
    expect(Object.keys(v).sort()).toEqual(
      [
        "id", "version", "status", "emailTo", "emailSubject", "emailBody", "letterMd",
        "fitGrade", "fitAnalysis", "cvJson", "cvFileId", "cvPdfStale", "rejectReason",
        "changeRequest", "changeRequestedAt", "changeRequestResponse", "sendStartedAt",
        "sendOutcome", "updatedAt", "job",
      ].sort(),
    );
    expect(Object.keys(v.job).sort()).toEqual(
      ["Company", "JobTitle", "description", "id", "jobUrl"].sort(),
    );
    expect(v.job.JobTitle).toEqual({ label: "T" });
    expect(v.job.Company).toEqual({ label: "C" });
  });
});
