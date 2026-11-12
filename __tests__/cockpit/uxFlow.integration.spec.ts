// @vitest-environment node
import { Prisma } from "@prisma/client";

// D-041: reopen, contactSource through submit, link-apply from pending, To do count.
const db = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("./helpers/sqlite");
  return createCockpitTestDb();
});
vi.mock("@/lib/db", () => ({ default: db.prisma }));

import {
  countTodo,
  markPackageAppliedManually,
  rejectPackage,
  reopenPackage,
  submitPackage,
} from "@/lib/cockpit/packages";
import { createJobFor, seedUserWithRefs, type SeededUser } from "./helpers/seedUser";

const prisma = db.prisma;
let a: SeededUser;
let b: SeededUser;
let draftId: string;
let appliedId: string;
let n = 0;

beforeAll(async () => {
  a = await seedUserWithRefs(prisma, "a@example.com");
  b = await seedUserWithRefs(prisma, "b@example.com");
  draftId = (await prisma.jobStatus.create({ data: { label: "Draft", value: "draft" } })).id;
  appliedId = (await prisma.jobStatus.create({ data: { label: "Applied", value: "applied" } })).id;
}, 120_000);
afterAll(async () => {
  await db.cleanup();
});

const mk = async (status: string, over: Record<string, unknown> = {}, u = a) => {
  const jobId = (over.jobId as string | undefined) ?? (await createJobFor(prisma, u, draftId));
  return prisma.applicationPackage.create({
    data: {
      userId: u.id,
      jobId,
      version: ++n,
      status,
      emailTo: "hr@example.com",
      emailSubject: "S",
      emailBody: "B",
      ...over,
    },
  });
};
const row = (id: string) => prisma.applicationPackage.findUniqueOrThrow({ where: { id } });

describe("reopenPackage", () => {
  it("rejected goes back to pending and the reject data is cleared", async () => {
    const p = await mk("pending");
    await rejectPackage(a.id, p.id, "Not a fit");
    expect(await row(p.id)).toMatchObject({ status: "rejected", rejectReason: "Not a fit" });
    const r = await reopenPackage(a.id, p.id);
    expect(r).toMatchObject({ status: "pending", rejectReason: null, rejectedAt: null, approvedAt: null });
  });

  it("only a rejected package can be reopened", async () => {
    for (const s of ["pending", "approved", "sent", "superseded", "changes_requested"]) {
      const p = await mk(s);
      await expect(reopenPackage(a.id, p.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect((await row(p.id)).status).toBe(s);
    }
  });

  it("a locked (send started) package is never reopened", async () => {
    const p = await mk("rejected", { sendStartedAt: new Date() });
    await expect(reopenPackage(a.id, p.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("another user's package is NOT_FOUND and stays rejected", async () => {
    const p = await mk("rejected", {}, b);
    await expect(reopenPackage(a.id, p.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await row(p.id)).status).toBe("rejected");
  });

  it("refused when the job has another live package", async () => {
    const rejected = await mk("rejected");
    await mk("pending", { jobId: rejected.jobId });
    await expect(reopenPackage(a.id, rejected.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("after reopening, the bot's submit is no longer refused with JOB_REJECTED", async () => {
    const p = await mk("rejected");
    await expect(
      submitPackage(a.id, {
        jobId: p.jobId, emailTo: "hr@example.com", emailSubject: "S", emailBody: "B", fitGrade: "A",
      }),
    ).rejects.toMatchObject({ code: "JOB_REJECTED" });
    await reopenPackage(a.id, p.id);
    const res = await submitPackage(a.id, {
      jobId: p.jobId, emailTo: "hr@example.com", emailSubject: "S", emailBody: "B", fitGrade: "A",
    });
    expect(res.package.version).toBe(p.version + 1);
    expect((await row(p.id)).status).toBe("superseded");
  });
});

describe("reopenPackage (review of PR #95)", () => {
  it("refused when the job has a sent application", async () => {
    // The sent one is the OLDER version, so only the live-package rule refuses.
    const sent = await mk("sent");
    const rejected = await mk("rejected", { jobId: sent.jobId });
    await expect(reopenPackage(a.id, rejected.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await row(rejected.id)).status).toBe("rejected");
  });

  it("refused for an older rejected version when a newer version is rejected too", async () => {
    const older = await mk("rejected");
    const newer = await mk("rejected", { jobId: older.jobId });
    await expect(reopenPackage(a.id, older.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await row(older.id)).status).toBe("rejected");
    // The active (newest) one can come back.
    expect((await reopenPackage(a.id, newer.id)).status).toBe("pending");
  });

  it("an older superseded version does not block reopening the active one", async () => {
    const old = await mk("superseded");
    const active = await mk("rejected", { jobId: old.jobId });
    expect((await reopenPackage(a.id, active.id)).status).toBe("pending");
  });

  it("a rejected follow-up draft is never reopened", async () => {
    const fu = await mk("rejected", { kind: "follow_up" });
    await expect(reopenPackage(a.id, fu.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await row(fu.id)).status).toBe("rejected");
  });
});

describe("rejectPackage reason (D-041)", () => {
  it("no reason, blank or spaces are stored as null; a reason is trimmed", async () => {
    for (const reason of [undefined, "", "   "]) {
      const p = await mk("pending");
      await rejectPackage(a.id, p.id, reason);
      expect(await row(p.id)).toMatchObject({ status: "rejected", rejectReason: null });
    }
    const p = await mk("pending");
    await rejectPackage(a.id, p.id, "  Too far  ");
    expect((await row(p.id)).rejectReason).toBe("Too far");
  });
});

const ZW = String.fromCharCode(0x200b);
const ZWJ = String.fromCharCode(0x200d);
const RLO = String.fromCharCode(0x202e);
const LS = String.fromCharCode(0x2028);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

describe("contactSource cleaning (review of PR #95)", () => {
  it("CR/LF, tabs, zero-width and bidi controls become one space", async () => {
    const base = { emailTo: "hr@example.com", emailSubject: "S", emailBody: "B", fitGrade: "A" as const };
    const r = await submitPackage(a.id, {
      ...base,
      jobId: await createJobFor(prisma, a, draftId),
      contactSource: "https://acme.example/" + CR + LF + "careers" + ZW + RLO + "gpj.exe" + TAB + "tab" + LS + "x",
    });
    expect(r.package.contactSource).toBe("https://acme.example/ careers gpj.exe tab x");
    const z = await submitPackage(a.id, {
      ...base,
      jobId: await createJobFor(prisma, a, draftId),
      contactSource: ZW + ZWJ + CR + LF,
    });
    expect(z.package.contactSource).toBeNull();
  });
});

describe("contactSource", () => {
  it("is stored trimmed, blank becomes null, absent is null", async () => {
    const mkJob = () => createJobFor(prisma, a, draftId);
    const base = { emailTo: "hr@example.com", emailSubject: "S", emailBody: "B", fitGrade: "A" as const };
    const r1 = await submitPackage(a.id, { ...base, jobId: await mkJob(), contactSource: "  https://acme.example/careers " });
    expect(r1.package.contactSource).toBe("https://acme.example/careers");
    const r2 = await submitPackage(a.id, { ...base, jobId: await mkJob(), contactSource: "   " });
    expect(r2.package.contactSource).toBeNull();
    const r3 = await submitPackage(a.id, { ...base, jobId: await mkJob() });
    expect(r3.package.contactSource).toBeNull();
  });
});

describe("link-apply from pending (no Approve needed)", () => {
  it("pending without a recipient can be marked applied; the job moves to applied", async () => {
    const p = await mk("pending", { emailTo: null });
    const r = await markPackageAppliedManually(a.id, p.id);
    expect(r).toMatchObject({ status: "sent", sentVia: "manual" });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: p.jobId } });
    expect(job.statusId).toBe(appliedId);
    expect(job.applied).toBe(true);
  });

  it("approved without a recipient can be marked applied too", async () => {
    const p = await mk("approved", { emailTo: "" });
    expect((await markPackageAppliedManually(a.id, p.id)).status).toBe("sent");
  });

  it("a follow-up draft without a recipient is refused (never marks the job applied)", async () => {
    const p = await mk("pending", { kind: "follow_up", emailTo: null });
    await expect(markPackageAppliedManually(a.id, p.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await row(p.id)).status).toBe("pending");
  });

  it("rejected, changes_requested or locked packages are refused", async () => {
    for (const over of [
      { status: "rejected" },
      { status: "changes_requested" },
      { status: "pending", sendStartedAt: new Date() },
    ]) {
      const p = await mk(over.status, { emailTo: null, ...over });
      await expect(markPackageAppliedManually(a.id, p.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    }
  });

  it("a package WITH a recipient is still refused (no email is skipped silently)", async () => {
    const p = await mk("pending");
    await expect(markPackageAppliedManually(a.id, p.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await row(p.id)).status).toBe("pending");
  });
});

describe("countTodo", () => {
  it("counts pending and approved of this user only", async () => {
    const before = await countTodo(a.id);
    await mk("pending");
    await mk("approved");
    await mk("rejected");
    await mk("sent");
    await mk("pending", {}, b);
    expect(await countTodo(a.id)).toBe(before + 2);
  });

  it("does not count follow-up drafts (they are not in the To do tab)", async () => {
    const before = await countTodo(a.id);
    await mk("pending", { kind: "follow_up" });
    await mk("approved", { kind: "follow_up" });
    expect(await countTodo(a.id)).toBe(before);
  });
});

void Prisma;
