// @vitest-environment node
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";

const state = vi.hoisted(() => ({ uploads: "" }));

vi.mock("@/lib/constants", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/constants")>();
  return {
    ...mod,
    APP_CONSTANTS: {
      ...mod.APP_CONSTANTS,
      get UPLOADS_DIR() {
        return state.uploads;
      },
    },
  };
});
vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/telemetry", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  default: {
    gmailAccount: { findUnique: vi.fn() },
    applicationPackage: { count: vi.fn() },
  },
}));
vi.mock("@/lib/cockpit/packages", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/cockpit/packages")>();
  return {
    ...mod,
    approvePackage: vi.fn(),
    unapprovePackage: vi.fn(),
    rejectPackage: vi.fn(),
    requestPackageChanges: vi.fn(),
    updatePackageContent: vi.fn(),
    markPackageAppliedManually: vi.fn(),
    reopenPackage: vi.fn(),
    countTodo: vi.fn(),
    listPackagesByTab: vi.fn(),
    getPackageWithJob: vi.fn(),
    listJobVersions: vi.fn(),
    listSendHistory: vi.fn(),
  };
});

import { revalidatePath } from "next/cache";
import prisma from "@/lib/db";
import { getCurrentUser } from "@/utils/user.utils";
import * as svc from "@/lib/cockpit/packages";
import { CockpitError } from "@/lib/cockpit/errors";
import * as actions from "@/actions/cockpit.actions";

const user = { id: "u1" };
const gmailFind = prisma.gmailAccount.findUnique as ReturnType<typeof vi.fn>;
const pkgCount = prisma.applicationPackage.count as ReturnType<typeof vi.fn>;
const m = (f: unknown) => f as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("COCKPIT_ENABLED", "true");
  m(getCurrentUser).mockResolvedValue(user);
});
afterEach(() => vi.unstubAllEnvs());

const mutations: [string, () => Promise<unknown>, ReturnType<typeof vi.fn>, unknown[]][] = [
  ["approvePackage", () => actions.approvePackage("p1"), m(svc.approvePackage), ["u1", "p1"]],
  ["unapprovePackage", () => actions.unapprovePackage("p1"), m(svc.unapprovePackage), ["u1", "p1"]],
  ["rejectPackage", () => actions.rejectPackage("p1", "no"), m(svc.rejectPackage), ["u1", "p1", "no"]],
  [
    "requestPackageChanges",
    () => actions.requestPackageChanges("p1", "fix"),
    m(svc.requestPackageChanges),
    ["u1", "p1", "fix"],
  ],
  [
    "updatePackageContent",
    () => actions.updatePackageContent("p1", { emailSubject: "Hi" }),
    m(svc.updatePackageContent),
    ["u1", "p1", { emailSubject: "Hi" }],
  ],
  [
    "markPackageAppliedManually",
    () => actions.markPackageAppliedManually("p1"),
    m(svc.markPackageAppliedManually),
    ["u1", "p1"],
  ],
  // D-041
  ["reopenPackage", () => actions.reopenPackage("p1"), m(svc.reopenPackage), ["u1", "p1"]],
  [
    "rejectPackage without a reason",
    () => actions.rejectPackage("p1"),
    m(svc.rejectPackage),
    ["u1", "p1", undefined],
  ],
];

describe.each(mutations)("%s", (_name, call, service, args) => {
  it("calls the service with the session user id, returns data, revalidates", async () => {
    service.mockResolvedValue({ id: "p1", status: "x" });
    await expect(call()).resolves.toEqual({
      success: true,
      data: { id: "p1", status: "x" },
    });
    expect(service).toHaveBeenCalledWith(...args);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/review");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/review/p1");
    // Only the actions that change what the job list shows (applied; the
    // reopened package's status, D-041) refresh the job list.
    expect(
      (revalidatePath as ReturnType<typeof vi.fn>).mock.calls.some(
        ([p]) => p === "/dashboard/myjobs",
      ),
    ).toBe(_name === "markPackageAppliedManually" || _name === "reopenPackage");
  });

  it("returns COCKPIT_DISABLED when the flag is off, without calling the service", async () => {
    vi.stubEnv("COCKPIT_ENABLED", "false");
    const r = await call();
    expect(r).toMatchObject({ success: false, code: "COCKPIT_DISABLED" });
    expect(service).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["INVALID_STATE", "CONFLICT", "INTERNAL"] as const)(
    "maps a service CockpitError (%s) to its code and still revalidates (the page was stale)",
    async (code) => {
      service.mockRejectedValue(new CockpitError(code));
      const r = await call();
      expect(r).toMatchObject({ success: false, code });
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/review");
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/review/p1");
    },
  );

  it("NOT_FOUND refreshes only the list, never the path built from the client id", async () => {
    service.mockRejectedValue(new CockpitError("NOT_FOUND"));
    expect(await call()).toMatchObject({ success: false, code: "NOT_FOUND" });
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/review");
  });

  it("VALIDATION revalidates nothing (an input error changes no state)", async () => {
    service.mockRejectedValue(new CockpitError("VALIDATION"));
    expect(await call()).toMatchObject({ success: false, code: "VALIDATION" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns UNAUTHENTICATED and skips the service when the user is null", async () => {
    m(getCurrentUser).mockResolvedValue(null);
    const r = await call();
    expect(r).toMatchObject({ success: false, code: "UNAUTHENTICATED" });
    expect(service).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// Every export, not just the approve path: auth is checked before the flag
// (the flag is not probeable) and before any service or DB access.
const everyAction: [string, () => Promise<unknown>][] = [
  ...mutations.map(([n, call]) => [n, call] as [string, () => Promise<unknown>]),
  ["getReviewQueue", () => actions.getReviewQueue("todo")],
  ["getPackageDetail", () => actions.getPackageDetail("p1")],
  ["getAdjacentPackageIds", () => actions.getAdjacentPackageIds("p1")],
  ["getTodoCount", () => actions.getTodoCount()],
];

describe.each(everyAction)("%s auth and flag order", (_n, call) => {
  const serviceCalls = () =>
    Object.values(svc).some((f) => vi.isMockFunction(f) && f.mock.calls.length > 0) ||
    gmailFind.mock.calls.length > 0 ||
    pkgCount.mock.calls.length > 0;

  it("anonymous + flag off gives UNAUTHENTICATED and touches nothing", async () => {
    vi.stubEnv("COCKPIT_ENABLED", "false");
    m(getCurrentUser).mockResolvedValue(null);
    expect(await call()).toMatchObject({ success: false, code: "UNAUTHENTICATED" });
    expect(serviceCalls()).toBe(false);
  });

  it("flag off gives COCKPIT_DISABLED and touches nothing", async () => {
    vi.stubEnv("COCKPIT_ENABLED", "false");
    expect(await call()).toMatchObject({ success: false, code: "COCKPIT_DISABLED" });
    expect(serviceCalls()).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("getReviewQueue", () => {
  it("returns rows, the gmail email only, and the callout flag", async () => {
    m(svc.listPackagesByTab).mockResolvedValue([{ id: "p1" }]);
    gmailFind.mockResolvedValue(null);
    pkgCount.mockResolvedValue(2);
    const r = await actions.getReviewQueue("todo");
    expect(svc.listPackagesByTab).toHaveBeenCalledWith("u1", "todo");
    expect(r).toEqual({
      success: true,
      data: { rows: [{ id: "p1" }], gmail: null, gmailCalloutNeeded: true },
    });
    expect(gmailFind).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { email: true, scopes: true },
    });
    expect(pkgCount.mock.calls[0][0].where).toMatchObject({
      userId: "u1",
      status: "approved",
    });
  });

  it("no callout when Gmail is connected", async () => {
    m(svc.listPackagesByTab).mockResolvedValue([]);
    gmailFind.mockResolvedValue({ email: "you@example.com", scopes: "s" });
    pkgCount.mockResolvedValue(3);
    const r = await actions.getReviewQueue("sent");
    expect(r).toMatchObject({
      success: true,
      data: { gmail: { email: "you@example.com" }, gmailCalloutNeeded: false },
    });
  });

  it("rejects an unknown tab with VALIDATION before any query", async () => {
    const r = await actions.getReviewQueue("__proto__" as never);
    expect(r).toMatchObject({ success: false, code: "VALIDATION" });
    expect(svc.listPackagesByTab).not.toHaveBeenCalled();
  });
});

describe("getAdjacentPackageIds", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it.each([
    // todoLeft: the other To do items besides this one (D-041, auto-advance toast).
    ["a", { previousId: null, nextId: "b", todoLeft: 2 }],
    ["b", { previousId: "a", nextId: "c", todoLeft: 2 }],
    ["c", { previousId: "b", nextId: null, todoLeft: 2 }],
    ["zzz", { previousId: null, nextId: null, todoLeft: 3 }],
  ])("%s", async (id, expected) => {
    m(svc.listPackagesByTab).mockResolvedValue(rows);
    expect(await actions.getAdjacentPackageIds(id)).toEqual({
      success: true,
      data: expected,
    });
    expect(svc.listPackagesByTab).toHaveBeenCalledWith("u1", "todo");
  });
});

describe("getTodoCount (D-041)", () => {
  it("returns the To do count for the session user", async () => {
    m(svc.countTodo).mockResolvedValue(4);
    expect(await actions.getTodoCount()).toEqual({ success: true, data: 4 });
    expect(svc.countTodo).toHaveBeenCalledWith("u1");
  });
});

describe("getPackageDetail", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-detail-"));
    state.uploads = root;
    m(svc.listSendHistory).mockResolvedValue([]);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const stored = (name = "abc.pdf", body = "%PDF-1.4 hello") => {
    const p = path.join(root, "files", "cockpit", "u1", name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };

  // A full database row, including the columns the client must never get.
  const row = (over: Record<string, unknown> = {}) => ({
    id: "p2",
    userId: "u1",
    jobId: "j1",
    version: 2,
    status: "pending",
    emailTo: "jobs@acme.example",
    emailSubject: "Hi",
    emailBody: "Body",
    letterMd: null,
    fitGrade: "A",
    fitAnalysis: null,
    cvJson: null,
    cvFileId: "f1",
    cvPdfStale: false,
    sourceFolder: "SECRET-FOLDER",
    idempotencyKey: "SECRET-KEY",
    rejectReason: null,
    changeRequest: null,
    changeRequestedAt: null,
    changeRequestHandledAt: null,
    changeRequestResponse: null,
    editedAt: null,
    approvedAt: null,
    rejectedAt: null,
    sendStartedAt: null,
    sendOutcome: null,
    sentAt: null,
    sentVia: null,
    createdAt: new Date("2026-11-01T10:00:00Z"),
    updatedAt: new Date("2026-11-01T10:00:00Z"),
    cvFile: null,
    job: {
      id: "j1",
      jobUrl: "https://acme.example/1",
      description: "<p>d</p>",
      JobTitle: { label: "Dev" },
      Company: { label: "Acme" },
    },
    ...over,
  });
  const versions = (id = "p2") => [{ id, version: 2, status: "pending" }];

  it("returns the send history scoped to the user, with fixed reasons only (D-028)", async () => {
    m(svc.getPackageWithJob).mockResolvedValue(row());
    m(svc.listJobVersions).mockResolvedValue(versions());
    m(svc.listSendHistory).mockResolvedValue([
      {
        id: "a1",
        outcome: "failed",
        errorCode: "GMAIL_SEND",
        gmailMessageId: null,
        createdAt: new Date("2026-11-01T08:00:00Z"),
        threadId: "must-not-leak",
        userId: "must-not-leak",
      },
    ]);
    const res = await actions.getPackageDetail("p2");
    expect(svc.listSendHistory).toHaveBeenCalledWith("u1", "p2");
    expect(res).toMatchObject({
      success: true,
      data: {
        sendHistory: [
          { id: "a1", outcome: "failed", reason: "Gmail rejected the message" },
        ],
      },
    });
    expect(JSON.stringify(res)).not.toContain("must-not-leak");
  });

  it("returns the attachment name and size, versions, the active id and a safe gmail view (AC-43)", async () => {
    const filePath = stored();
    m(svc.getPackageWithJob).mockResolvedValue(
      row({ cvFile: { id: "f1", fileName: "Jane Doe CV.pdf", filePath } }),
    );
    m(svc.listJobVersions).mockResolvedValue([
      { id: "p3", version: 3, status: "pending" },
      { id: "p2", version: 2, status: "superseded" },
    ]);
    gmailFind.mockResolvedValue({
      email: "you@example.com",
      scopes: "gmail.send",
      encryptedRefreshToken: "SECRET",
      iv: "IV",
    });
    const r = await actions.getPackageDetail("p2");
    expect(svc.getPackageWithJob).toHaveBeenCalledWith("u1", "p2");
    expect(r).toMatchObject({
      success: true,
      data: {
        activePackageId: "p3",
        isActive: false,
        // Display name (sanitized), not the generated on-disk name.
        attachment: { fileName: "Jane_Doe_CV.pdf", size: 14 },
        gmail: { email: "you@example.com", scopes: "gmail.send" },
      },
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("encryptedRefreshToken");
    expect(json).not.toContain(filePath);
    expect(gmailFind.mock.calls[0][0].select).toEqual({
      email: true,
      scopes: true,
    });
  });

  it("returns an explicit package view: no key, folder, user id or send internals", async () => {
    m(svc.getPackageWithJob).mockResolvedValue(row());
    m(svc.listJobVersions).mockResolvedValue(versions());
    gmailFind.mockResolvedValue(null);
    const r = await actions.getPackageDetail("p2");
    if (!r.success) throw new Error("expected success");
    const pkg = r.data.package as Record<string, unknown>;
    for (const k of [
      "idempotencyKey",
      "sourceFolder",
      "userId",
      "jobId",
      "approvedAt",
      "rejectedAt",
      "editedAt",
      "sentAt",
      "sentVia",
      "createdAt",
      "changeRequestHandledAt",
      "cvFile",
    ]) {
      expect(pkg, k).not.toHaveProperty(k);
    }
    expect(JSON.stringify(r)).not.toMatch(/SECRET-(KEY|FOLDER)/);
    // What the UI renders and the send dialog needs stays.
    expect(pkg).toMatchObject({
      id: "p2",
      status: "pending",
      emailSubject: "Hi",
      sendStartedAt: null,
      sendOutcome: null,
      updatedAt: new Date("2026-11-01T10:00:00Z"),
      job: {
        jobUrl: "https://acme.example/1",
        description: "<p>d</p>",
        JobTitle: { label: "Dev" },
        Company: { label: "Acme" },
      },
    });
  });

  it.each([
    ["the connected address matches the allow-list (case and spaces ignored)", " You@Example.com ", "you@example.com", true],
    ["a different address is connected", "other@example.com", "you@example.com", false],
    ["the allow-list is unset", "you@example.com", "", false],
    ["no Gmail account is connected", null, "you@example.com", false],
  ])("gmailSendAllowed: %s", async (_n, connected, allowList, expected) => {
    vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", allowList);
    m(svc.getPackageWithJob).mockResolvedValue(row());
    m(svc.listJobVersions).mockResolvedValue(versions());
    gmailFind.mockResolvedValue(connected ? { email: connected, scopes: "s" } : null);
    const r = await actions.getPackageDetail("p2");
    expect(r).toMatchObject({ success: true, data: { gmailSendAllowed: expected } });
  });

  it("attachment is null when the file is outside the cockpit dir", async () => {
    const outside = path.join(root, "elsewhere.pdf");
    fs.writeFileSync(outside, "%PDF-");
    m(svc.getPackageWithJob).mockResolvedValue(
      row({ id: "p1", cvFile: { id: "f1", fileName: "x.pdf", filePath: outside } }),
    );
    m(svc.listJobVersions).mockResolvedValue(versions("p1"));
    gmailFind.mockResolvedValue(null);
    const r = await actions.getPackageDetail("p1");
    expect(r).toMatchObject({
      success: true,
      data: { attachment: null, gmail: null, isActive: true },
    });
  });

  it("attachment is null when the stored file vanished (stat fails)", async () => {
    const filePath = stored();
    m(svc.getPackageWithJob).mockResolvedValue(
      row({ cvFile: { id: "f1", fileName: "x.pdf", filePath } }),
    );
    m(svc.listJobVersions).mockResolvedValue(versions());
    gmailFind.mockResolvedValue(null);
    // realpath (confinement) succeeds; only the final stat fails.
    const statSpy = vi.spyOn(fsp, "stat").mockRejectedValue(new Error("ENOENT"));
    try {
      const r = await actions.getPackageDetail("p2");
      expect(r).toMatchObject({ success: true, data: { attachment: null } });
    } finally {
      statSpy.mockRestore();
    }
  });

  it("cvFile is null: no attachment; letterAttachment follows the letter text", async () => {
    m(svc.listJobVersions).mockResolvedValue(versions());
    gmailFind.mockResolvedValue(null);

    m(svc.getPackageWithJob).mockResolvedValue(row({ letterMd: "Dear team" }));
    const withLetter = await actions.getPackageDetail("p2");
    expect(withLetter).toMatchObject({
      success: true,
      data: { attachment: null, letterAttachment: { fileName: expect.any(String) } },
    });

    for (const letterMd of [null, "", "   \n "]) {
      m(svc.getPackageWithJob).mockResolvedValue(row({ letterMd }));
      const r = await actions.getPackageDetail("p2");
      expect(r, JSON.stringify(letterMd)).toMatchObject({
        success: true,
        data: { letterAttachment: null },
      });
    }
  });

  it("NOT_FOUND from the service becomes a failure result", async () => {
    m(svc.getPackageWithJob).mockRejectedValue(new CockpitError("NOT_FOUND"));
    expect(await actions.getPackageDetail("nope")).toMatchObject({
      success: false,
      code: "NOT_FOUND",
    });
  });
});

describe("updatePackageContent patches", () => {
  it("forwards every patch shape to the service unchanged", async () => {
    m(svc.updatePackageContent).mockResolvedValue({ id: "p1" });
    const patches = [
      { emailTo: null },
      { emailBody: "b", letterMd: "l" },
      { cvJson: '{"name":"x"}' },
    ];
    for (const patch of patches) {
      await actions.updatePackageContent("p1", patch as never);
      expect(svc.updatePackageContent).toHaveBeenLastCalledWith("u1", "p1", patch);
    }
  });

  it("a service VALIDATION failure comes back as VALIDATION", async () => {
    m(svc.updatePackageContent).mockRejectedValue(new CockpitError("VALIDATION"));
    expect(await actions.updatePackageContent("p1", { emailTo: "x" } as never)).toMatchObject({
      success: false,
      code: "VALIDATION",
    });
  });
});
