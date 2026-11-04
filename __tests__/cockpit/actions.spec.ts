// @vitest-environment node
import fs from "fs";
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
    listPackagesByTab: vi.fn(),
    getPackageWithJob: vi.fn(),
    listJobVersions: vi.fn(),
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
  });

  it("returns COCKPIT_DISABLED when the flag is off, without calling the service", async () => {
    vi.stubEnv("COCKPIT_ENABLED", "false");
    const r = await call();
    expect(r).toMatchObject({ success: false, code: "COCKPIT_DISABLED" });
    expect(service).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("maps a service CockpitError to its code (INVALID_STATE) and does not revalidate", async () => {
    service.mockRejectedValue(new CockpitError("INVALID_STATE"));
    const r = await call();
    expect(r).toMatchObject({ success: false, code: "INVALID_STATE" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns UNAUTHENTICATED and skips the service when the user is null", async () => {
    m(getCurrentUser).mockResolvedValue(null);
    const r = await call();
    expect(r).toMatchObject({ success: false, code: "UNAUTHENTICATED" });
    expect(service).not.toHaveBeenCalled();
  });
});

describe("flag check order", () => {
  it("anonymous + flag off gives UNAUTHENTICATED (flag not probeable)", async () => {
    vi.stubEnv("COCKPIT_ENABLED", "false");
    m(getCurrentUser).mockResolvedValue(null);
    expect(await actions.approvePackage("p1")).toMatchObject({
      code: "UNAUTHENTICATED",
    });
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
    ["a", { previousId: null, nextId: "b" }],
    ["b", { previousId: "a", nextId: "c" }],
    ["c", { previousId: "b", nextId: null }],
    ["zzz", { previousId: null, nextId: null }],
  ])("%s", async (id, expected) => {
    m(svc.listPackagesByTab).mockResolvedValue(rows);
    expect(await actions.getAdjacentPackageIds(id)).toEqual({
      success: true,
      data: expected,
    });
    expect(svc.listPackagesByTab).toHaveBeenCalledWith("u1", "todo");
  });
});

describe("getPackageDetail", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-detail-"));
    state.uploads = root;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const stored = (name = "abc.pdf", body = "%PDF-1.4 hello") => {
    const p = path.join(root, "files", "cockpit", "u1", name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };

  it("returns the attachment name and size, versions, the active id and a safe gmail view (AC-43)", async () => {
    const filePath = stored();
    m(svc.getPackageWithJob).mockResolvedValue({
      id: "p2",
      jobId: "j1",
      cvJson: null,
      cvFile: { id: "f1", fileName: "stored-name.pdf", filePath },
      job: { id: "j1" },
    });
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
        attachment: { fileName: "abc.pdf", size: 14 },
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

  it("attachment is null when the file is outside the cockpit dir", async () => {
    const outside = path.join(root, "elsewhere.pdf");
    fs.writeFileSync(outside, "%PDF-");
    m(svc.getPackageWithJob).mockResolvedValue({
      id: "p1",
      jobId: "j1",
      cvFile: { id: "f1", fileName: "x.pdf", filePath: outside },
    });
    m(svc.listJobVersions).mockResolvedValue([
      { id: "p1", version: 1, status: "pending" },
    ]);
    gmailFind.mockResolvedValue(null);
    const r = await actions.getPackageDetail("p1");
    expect(r).toMatchObject({
      success: true,
      data: { attachment: null, gmail: null, isActive: true },
    });
  });

  it("NOT_FOUND from the service becomes a failure result", async () => {
    m(svc.getPackageWithJob).mockRejectedValue(new CockpitError("NOT_FOUND"));
    expect(await actions.getPackageDetail("nope")).toMatchObject({
      success: false,
      code: "NOT_FOUND",
    });
  });
});
