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
});

void Prisma;
