// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { Prisma } from "@prisma/client";

// The temp DB is created (and DATABASE_URL set) before the code under test
// imports "@/lib/db", which is mocked to hand out the harness client.
const db = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("./helpers/sqlite");
  return createCockpitTestDb();
});
const uploads = vi.hoisted(() => ({ dir: "" }));

vi.mock("@/lib/db", () => ({ default: db.prisma }));
vi.mock("@/lib/constants", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/constants")>();
  return {
    ...mod,
    APP_CONSTANTS: {
      ...mod.APP_CONSTANTS,
      get UPLOADS_DIR() {
        return uploads.dir;
      },
    },
  };
});

import {
  approvePackage,
  getPackageWithJob,
  listJobVersions,
  listPackagesByTab,
  markChangeRequestDone,
  markJobApplied,
  markPackageAppliedManually,
  rejectPackage,
  requestPackageChanges,
  submitPackage,
  unapprovePackage,
  updatePackageContent,
  type PackageStatus,
} from "@/lib/cockpit/packages";
import { cockpitUserDir } from "@/lib/cockpit/files";
import { JOB_STATUSES } from "@/lib/constants";
import type { SubmitApplicationPackageInput } from "@/lib/cockpit/schemas";

const prisma = db.prisma;

let userA: string;
let userB: string;
const refs: Record<string, { titleId: string; companyId: string }> = {};
let draftId: string;
let appliedId: string;
let newStatusId: string;
let interviewId: string;

async function seedUser(email: string) {
  const user = await prisma.user.create({
    data: { name: "Jane Doe", email, password: "x" },
  });
  const title = await prisma.jobTitle.create({
    data: { label: "Engineer", value: `eng-${user.id}`, createdBy: user.id },
  });
  const company = await prisma.company.create({
    data: {
      label: "Example Corp",
      value: `corp-${user.id}`,
      createdBy: user.id,
    },
  });
  refs[user.id] = { titleId: title.id, companyId: company.id };
  return user.id;
}

const newJob = async (userId: string) =>
  (
    await prisma.job.create({
      data: {
        userId,
        description: "A synthetic job",
        jobType: "FT",
        createdAt: new Date(),
        statusId: draftId,
        jobTitleId: refs[userId].titleId,
        companyId: refs[userId].companyId,
      },
    })
  ).id;

const input = (
  jobId: string,
  over: Partial<SubmitApplicationPackageInput> = {},
): SubmitApplicationPackageInput => ({
  jobId,
  emailTo: "hr@example.com",
  emailSubject: "Application - Engineer",
  emailBody: "Hello, I am Jane Doe.",
  fitGrade: "A",
  ...over,
});

let versionCounter = 0;
// A package straight in the DB, in any status, in its own job unless given.
async function mk(
  status: PackageStatus,
  over: Record<string, unknown> = {},
  userId = userA,
) {
  const jobId = (over.jobId as string | undefined) ?? (await newJob(userId));
  return prisma.applicationPackage.create({
    data: {
      userId,
      jobId,
      version: ++versionCounter,
      status,
      emailTo: "hr@example.com",
      emailSubject: "Application",
      emailBody: "Hello",
      ...over,
    },
  });
}

const row = (id: string) =>
  prisma.applicationPackage.findUniqueOrThrow({ where: { id } });

const code = (c: string) => ({ code: c });

beforeAll(async () => {
  uploads.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-uploads-"));
  userA = await seedUser("jane@example.com");
  userB = await seedUser("john@example.com");
  draftId = (
    await prisma.jobStatus.create({ data: { label: "Draft", value: "draft" } })
  ).id;
  appliedId = (
    await prisma.jobStatus.create({
      data: { label: "Applied", value: "applied" },
    })
  ).id;
  newStatusId = (
    await prisma.jobStatus.create({ data: { label: "New", value: "new" } })
  ).id;
  interviewId = (
    await prisma.jobStatus.create({
      data: { label: "Interview", value: "interview" },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  fs.rmSync(uploads.dir, { recursive: true, force: true });
  await db.cleanup();
});

describe("submitPackage", () => {
  it("creates version 1, pending, scoped to the caller (AC-02)", async () => {
    const jobId = await newJob(userA);
    const res = await submitPackage(
      userA,
      input(jobId, {
        emailTo: null,
        fitAnalysis: { grade: "A" },
        cvJson: { name: "Jane Doe" },
      }),
    );
    expect(res).toMatchObject({ supersededIds: [], idempotent: false });
    expect(res.package).toMatchObject({
      userId: userA,
      jobId,
      version: 1,
      status: "pending",
      emailTo: null,
      fitAnalysis: '{"grade":"A"}',
      cvJson: '{"name":"Jane Doe"}',
    });
  });

  it("creates n+1 and supersedes pending / approved / changes_requested (AC-03)", async () => {
    const jobId = await newJob(userA);
    const v1 = (await submitPackage(userA, input(jobId))).package;
    const v2 = (await submitPackage(userA, input(jobId))).package;
    expect(v2.version).toBe(2);
    expect((await row(v1.id)).status).toBe("superseded");

    await approvePackage(userA, v2.id);
    const v3 = await submitPackage(userA, input(jobId));
    expect(v3.package.version).toBe(3);
    expect(v3.supersededIds).toEqual([v2.id]);
    expect((await row(v2.id)).status).toBe("superseded");

    await requestPackageChanges(userA, v3.package.id, "Shorten the letter");
    const v4 = await submitPackage(userA, input(jobId));
    expect(v4.supersededIds).toEqual([v3.package.id]);
    const old = await row(v3.package.id);
    expect(old.status).toBe("superseded");
    expect(old.changeRequestHandledAt).toBeInstanceOf(Date);
    expect(await listJobVersions(userA, jobId)).toHaveLength(4);
  });

  it("returns the existing package for the same idempotencyKey (AC-04)", async () => {
    const jobId = await newJob(userA);
    const first = await submitPackage(
      userA,
      input(jobId, { idempotencyKey: "k-1" }),
    );
    const again = await submitPackage(
      userA,
      input(jobId, { idempotencyKey: "k-1", emailBody: "changed" }),
    );
    expect(again).toMatchObject({ idempotent: true, supersededIds: [] });
    expect(again.package.id).toBe(first.package.id);
    expect(again.package.emailBody).toBe("Hello, I am Jane Doe.");
    expect(await prisma.applicationPackage.count({ where: { jobId } })).toBe(1);
  });

  it("two concurrent submits with one key create one package (AC-04)", async () => {
    const jobId = await newJob(userA);
    const results = await Promise.all([
      submitPackage(userA, input(jobId, { idempotencyKey: "race-1" })),
      submitPackage(userA, input(jobId, { idempotencyKey: "race-1" })),
    ]);
    expect(results.map((r) => r.idempotent).sort()).toEqual([false, true]);
    expect(results[0].package.id).toBe(results[1].package.id);
    expect(await prisma.applicationPackage.count({ where: { jobId } })).toBe(1);
  });

  it("the P2002 loser on (userId, idempotencyKey) returns the winner, not CONFLICT (AC-04)", async () => {
    const jobId = await newJob(userA);
    const winner = await mk("pending", { jobId, idempotencyKey: "race-2" });
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["userId", "idempotencyKey"] },
      }),
    );
    const res = await submitPackage(
      userA,
      input(jobId, { idempotencyKey: "race-2" }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ idempotent: true, supersededIds: [] });
    expect(res.package.id).toBe(winner.id);
  });

  it("returns CONFLICT when the key belongs to a package of another job (D-008)", async () => {
    const jobA1 = await newJob(userA);
    const jobA2 = await newJob(userA);
    const first = await submitPackage(
      userA,
      input(jobA1, { idempotencyKey: "cross-1" }),
    );
    await expect(
      submitPackage(userA, input(jobA2, { idempotencyKey: "cross-1" })),
    ).rejects.toMatchObject(code("CONFLICT"));
    expect(
      await prisma.applicationPackage.count({ where: { jobId: jobA2 } }),
    ).toBe(0);
    // The same job still replays.
    const again = await submitPackage(
      userA,
      input(jobA1, { idempotencyKey: "cross-1" }),
    );
    expect(again).toMatchObject({ idempotent: true });
    expect(again.package.id).toBe(first.package.id);
  });

  it("the P2002 loser on a key held by another job gets CONFLICT, not that package (D-008)", async () => {
    const jobA1 = await newJob(userA);
    const jobA2 = await newJob(userA);
    await mk("pending", { jobId: jobA1, idempotencyKey: "cross-2" });
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["userId", "idempotencyKey"] },
      }),
    );
    await expect(
      submitPackage(userA, input(jobA2, { idempotencyKey: "cross-2" })),
    ).rejects.toMatchObject(code("CONFLICT"));
  });

  it("reports a P2002 on (jobId, version) as CONFLICT", async () => {
    const jobId = await newJob(userA);
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["jobId", "version"] },
      }),
    );
    await expect(submitPackage(userA, input(jobId))).rejects.toMatchObject(
      code("CONFLICT"),
    );
  });

  it("reports a P2034 write conflict (SQLite busy) as CONFLICT, not INTERNAL (review 01 #3)", async () => {
    const jobId = await newJob(userA);
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("write conflict", {
        code: "P2034",
        clientVersion: "test",
      }),
    );
    await expect(submitPackage(userA, input(jobId))).rejects.toMatchObject(
      code("CONFLICT"),
    );
  });

  it.each(["P1008", "P2028"])(
    "reports a %s (SQLite busy / transaction timeout) as CONFLICT, not INTERNAL (review 01 #3)",
    async (prismaCode) => {
      const jobId = await newJob(userA);
      vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("busy", {
          code: prismaCode,
          clientVersion: "test",
        }),
      );
      await expect(submitPackage(userA, input(jobId))).rejects.toMatchObject(
        code("CONFLICT"),
      );
    },
  );

  it("two real concurrent submits with different keys: one active package, any loser is CONFLICT (review 01 #3)", async () => {
    const jobId = await newJob(userA);
    const results = await Promise.allSettled([
      submitPackage(userA, input(jobId, { idempotencyKey: "par-a" })),
      submitPackage(userA, input(jobId, { idempotencyKey: "par-b" })),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won.length).toBeGreaterThanOrEqual(1);
    for (const l of lost) {
      expect((l as PromiseRejectedResult).reason).toMatchObject(
        code("CONFLICT"),
      );
    }
    const rows = await prisma.applicationPackage.findMany({ where: { jobId } });
    expect(rows).toHaveLength(won.length);
    expect(new Set(rows.map((r) => r.version)).size).toBe(rows.length);
    expect(rows.filter((r) => r.status !== "superseded")).toHaveLength(1);
  });

  it("does not swallow other errors", async () => {
    const jobId = await newJob(userA);
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("boom"));
    await expect(submitPackage(userA, input(jobId))).rejects.toThrow("boom");
  });

  it("fails with ALREADY_SENT when any package of the job was sent (AC-05)", async () => {
    const jobId = await newJob(userA);
    await mk("sent", { jobId, version: 1 });
    await mk("pending", { jobId, version: 2 });
    await expect(submitPackage(userA, input(jobId))).rejects.toMatchObject(
      code("ALREADY_SENT"),
    );
  });

  it("fails with JOB_REJECTED when the active package is rejected (AC-05)", async () => {
    const jobId = await newJob(userA);
    await mk("superseded", { jobId, version: 1 });
    await mk("rejected", { jobId, version: 2 });
    await expect(submitPackage(userA, input(jobId))).rejects.toMatchObject(
      code("JOB_REJECTED"),
    );
  });

  it("an older rejected package does not block while a newer one is active", async () => {
    const jobId = await newJob(userA);
    await mk("rejected", { jobId, version: 1 });
    await mk("pending", { jobId, version: 2 });
    // Active = v2 (pending); v1 rejected is not the active package.
    const res = await submitPackage(userA, input(jobId));
    expect(res.package.version).toBe(3);
  });

  it("returns CONFLICT when any package of the job is locked, and changes nothing (AC-34)", async () => {
    const jobId = await newJob(userA);
    const locked = await mk("approved", {
      jobId,
      version: 1,
      sendStartedAt: new Date(),
    });
    await expect(submitPackage(userA, input(jobId))).rejects.toMatchObject(
      code("CONFLICT"),
    );
    expect((await row(locked.id)).status).toBe("approved");
    expect(await prisma.applicationPackage.count({ where: { jobId } })).toBe(1);
  });

  it("fails with NOT_FOUND for another user's job and unknown jobs (AC-06)", async () => {
    const jobB = await newJob(userB);
    await expect(submitPackage(userA, input(jobB))).rejects.toMatchObject(
      code("NOT_FOUND"),
    );
    await expect(submitPackage(userA, input("nope"))).rejects.toMatchObject(
      code("NOT_FOUND"),
    );
    expect(
      await prisma.applicationPackage.count({ where: { jobId: jobB } }),
    ).toBe(0);
  });

  it("idempotency keys are per user", async () => {
    const jobB = await newJob(userB);
    await submitPackage(userB, input(jobB, { idempotencyKey: "shared" }));
    const jobA = await newJob(userA);
    // Same key, other user: keys are per user, so A gets its own package.
    const res = await submitPackage(
      userA,
      input(jobA, { idempotencyKey: "shared" }),
    );
    expect(res.idempotent).toBe(false);
    expect(res.package.userId).toBe(userA);
  });

  describe("cvFileId (AC-06)", () => {
    const makeFile = async (filePath: string) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "%PDF-1.4");
      return prisma.file.create({
        data: { fileName: "cv.pdf", filePath, fileType: "application/pdf" },
      });
    };

    it("accepts a file in the user's cockpit dir", async () => {
      const file = await makeFile(path.join(cockpitUserDir(userA), "a.pdf"));
      const res = await submitPackage(
        userA,
        input(await newJob(userA), { cvFileId: file.id }),
      );
      expect(res.package.cvFileId).toBe(file.id);
    });

    it("rejects another user's cockpit file, an outside file and an unknown id", async () => {
      const otherUsers = await makeFile(
        path.join(cockpitUserDir(userB), "b.pdf"),
      );
      const outside = await makeFile(
        path.join(uploads.dir, "files", "resumes", "r.pdf"),
      );
      const jobId = await newJob(userA);
      for (const cvFileId of [otherUsers.id, outside.id, "missing"]) {
        await expect(
          submitPackage(userA, input(jobId, { cvFileId })),
        ).rejects.toMatchObject(code("FILE_NOT_FOUND"));
      }
      expect(await prisma.applicationPackage.count({ where: { jobId } })).toBe(
        0,
      );
    });
  });
});

type Op = {
  name: string;
  from: PackageStatus[];
  run: (id: string, userId?: string) => Promise<unknown>;
};

const ops: Op[] = [
  {
    name: "approve",
    from: ["pending"],
    run: (id, u = userA) => approvePackage(u, id),
  },
  {
    name: "unapprove",
    from: ["approved"],
    run: (id, u = userA) => unapprovePackage(u, id),
  },
  {
    name: "reject",
    from: ["pending", "approved"],
    run: (id, u = userA) => rejectPackage(u, id, "Not a fit"),
  },
  {
    name: "requestChanges",
    from: ["pending", "approved"],
    run: (id, u = userA) => requestPackageChanges(u, id, "Shorten the letter"),
  },
  {
    name: "markChangeRequestDone",
    from: ["changes_requested"],
    run: (id, u = userA) => markChangeRequestDone(u, id, "Done"),
  },
  {
    name: "markAppliedManually",
    from: ["pending", "approved"],
    run: (id, u = userA) => markPackageAppliedManually(u, id),
  },
  {
    name: "updateContent",
    from: ["pending", "approved"],
    run: (id, u = userA) =>
      updatePackageContent(u, id, { emailBody: "Edited" }),
  },
];

const ALL_STATUSES: PackageStatus[] = [
  "pending",
  "approved",
  "rejected",
  "changes_requested",
  "sent",
  "superseded",
];

describe("lifecycle (SPEC §2.1)", () => {
  describe.each(ops)("$name", ({ from, run }) => {
    it.each(ALL_STATUSES)("from %s", async (status) => {
      // emailTo empty so that mark-applied-manually is eligible.
      const pkg = await mk(status, { emailTo: null });
      if (from.includes(status)) {
        await expect(run(pkg.id)).resolves.toBeDefined();
      } else {
        await expect(run(pkg.id)).rejects.toMatchObject(code("INVALID_STATE"));
        expect((await row(pkg.id)).status).toBe(status);
      }
    });

    it("is frozen by the send lock (AC-34)", async () => {
      const lockedAt = new Date();
      for (const status of from) {
        const pkg = await mk(status, {
          emailTo: null,
          sendStartedAt: lockedAt,
        });
        const before = await row(pkg.id);
        await expect(run(pkg.id)).rejects.toMatchObject(code("INVALID_STATE"));
        expect(await row(pkg.id)).toEqual(before);
      }
    });

    it("gives NOT_FOUND for another user's package and changes nothing", async () => {
      const pkg = await mk(from[0], { emailTo: null }, userB);
      const before = await row(pkg.id);
      await expect(run(pkg.id, userA)).rejects.toMatchObject(code("NOT_FOUND"));
      await expect(run("missing", userA)).rejects.toMatchObject(
        code("NOT_FOUND"),
      );
      expect(await row(pkg.id)).toEqual(before);
    });
  });

  it("approve / unapprove set and clear approvedAt", async () => {
    const pkg = await mk("pending");
    expect((await approvePackage(userA, pkg.id)).approvedAt).toBeInstanceOf(
      Date,
    );
    const back = await unapprovePackage(userA, pkg.id);
    expect(back).toMatchObject({ status: "pending", approvedAt: null });
  });

  it("reject stores the trimmed reason and rejectedAt; blank reason is VALIDATION", async () => {
    const pkg = await mk("approved");
    await expect(rejectPackage(userA, pkg.id, "   ")).rejects.toMatchObject(
      code("VALIDATION"),
    );
    expect((await row(pkg.id)).status).toBe("approved");
    const res = await rejectPackage(userA, pkg.id, "  Not a fit ");
    expect(res).toMatchObject({
      status: "rejected",
      rejectReason: "Not a fit",
    });
    expect(res.rejectedAt).toBeInstanceOf(Date);
  });

  it("keeps change-request fields as history on done, and a later request overwrites them (AC-12)", async () => {
    const pkg = await mk("pending");
    const req = await requestPackageChanges(
      userA,
      pkg.id,
      "Shorten the letter",
    );
    expect(req).toMatchObject({
      status: "changes_requested",
      changeRequest: "Shorten the letter",
      changeRequestHandledAt: null,
      changeRequestResponse: null,
    });
    expect(req.changeRequestedAt).toBeInstanceOf(Date);

    const done = await markChangeRequestDone(userA, pkg.id, "Shortened");
    expect(done).toMatchObject({
      status: "pending",
      changeRequest: "Shorten the letter",
      changeRequestResponse: "Shortened",
    });
    expect(done.changeRequestedAt).toEqual(req.changeRequestedAt);
    expect(done.changeRequestHandledAt).toBeInstanceOf(Date);

    const again = await requestPackageChanges(
      userA,
      pkg.id,
      "Fix the greeting",
    );
    expect(again).toMatchObject({
      changeRequest: "Fix the greeting",
      changeRequestHandledAt: null,
      changeRequestResponse: null,
    });
  });

  it("mark applied manually sets sent/manual and the job to applied; no SentEmail", async () => {
    const pkg = await mk("approved", { emailTo: "" });
    const res = await markPackageAppliedManually(userA, pkg.id);
    expect(res).toMatchObject({ status: "sent", sentVia: "manual" });
    expect(res.sentAt).toBeInstanceOf(Date);
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: pkg.jobId },
    });
    expect(job).toMatchObject({ applied: true, statusId: appliedId });
    expect(job.appliedDate).toBeInstanceOf(Date);
    expect(await prisma.sentEmail.count({ where: { packageId: pkg.id } })).toBe(
      0,
    );
  });

  it("mark applied manually moves a 'new' job forward but never a job already further on (review 01 #2)", async () => {
    const fresh = await mk("pending", { emailTo: null });
    await prisma.job.update({
      where: { id: fresh.jobId },
      data: { statusId: newStatusId },
    });
    await markPackageAppliedManually(userA, fresh.id);
    expect(
      await prisma.job.findUniqueOrThrow({ where: { id: fresh.jobId } }),
    ).toMatchObject({ statusId: appliedId, applied: true });

    const appliedOn = new Date("2026-03-01T00:00:00Z");
    const later = await mk("pending", { emailTo: null });
    await prisma.job.update({
      where: { id: later.jobId },
      data: { statusId: interviewId, applied: true, appliedDate: appliedOn },
    });
    const res = await markPackageAppliedManually(userA, later.id);
    expect(res.status).toBe("sent");
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: later.jobId },
    });
    expect(job.statusId).toBe(interviewId);
    expect(job.appliedDate).toEqual(appliedOn);
  });

  it("markJobApplied refuses an empty jobId instead of updating every job (review 01 #1)", async () => {
    const other = await mk("pending");
    await expect(
      prisma.$transaction((tx) =>
        markJobApplied(tx, userA, undefined as unknown as string, new Date()),
      ),
    ).rejects.toMatchObject(code("INTERNAL"));
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: other.jobId },
    });
    expect(job).toMatchObject({ statusId: draftId, applied: false });
  });

  it("mark applied manually rolls back when the 'applied' job status is missing (review 01 #14)", async () => {
    const pkg = await mk("approved", { emailTo: null });
    const before = await row(pkg.id);
    await prisma.jobStatus.update({
      where: { id: appliedId },
      data: { value: "applied-hidden" },
    });
    try {
      await expect(
        markPackageAppliedManually(userA, pkg.id),
      ).rejects.toMatchObject(code("INTERNAL"));
    } finally {
      await prisma.jobStatus.update({
        where: { id: appliedId },
        data: { value: "applied" },
      });
    }
    expect(await row(pkg.id)).toEqual(before);
    expect(
      await prisma.job.findUniqueOrThrow({ where: { id: pkg.jobId } }),
    ).toMatchObject({ statusId: draftId, applied: false, appliedDate: null });
  });

  it("mark applied manually under a send lock leaves the job untouched (review 01 #14)", async () => {
    const pkg = await mk("approved", {
      emailTo: null,
      sendStartedAt: new Date(),
    });
    const jobBefore = await prisma.job.findUniqueOrThrow({
      where: { id: pkg.jobId },
    });
    await expect(
      markPackageAppliedManually(userA, pkg.id),
    ).rejects.toMatchObject(code("INVALID_STATE"));
    expect(
      await prisma.job.findUniqueOrThrow({ where: { id: pkg.jobId } }),
    ).toEqual(jobBefore);
  });

  it("request changes clears approvedAt; the next version needs a fresh approval (review 01 #11)", async () => {
    const pkg = await mk("pending");
    await approvePackage(userA, pkg.id);
    const req = await requestPackageChanges(userA, pkg.id, "Shorten it");
    expect(req.approvedAt).toBeNull();
    const done = await markChangeRequestDone(userA, pkg.id, "Shortened");
    expect(done).toMatchObject({ status: "pending", approvedAt: null });
  });

  // Every status the app seeds (JOB_STATUSES), matched by value: only draft and
  // new move to applied; every other status, and its applied fields, is kept.
  it.each(JOB_STATUSES.map((s) => [s.value, s.label] as const))(
    "mark applied manually from job status '%s' (D-016 a)",
    async (value, label) => {
      const status = await prisma.jobStatus.upsert({
        where: { value },
        update: {},
        create: { value, label },
      });
      const pkg = await mk("pending", { emailTo: null });
      const appliedOn = new Date("2026-02-01T00:00:00Z");
      await prisma.job.update({
        where: { id: pkg.jobId },
        data: { statusId: status.id, applied: false, appliedDate: appliedOn },
      });
      await markPackageAppliedManually(userA, pkg.id);
      const job = await prisma.job.findUniqueOrThrow({
        where: { id: pkg.jobId },
      });
      expect((await row(pkg.id)).status).toBe("sent");
      if (value === "draft" || value === "new") {
        expect(job).toMatchObject({ statusId: appliedId, applied: true });
        expect(job.appliedDate).not.toEqual(appliedOn);
      } else {
        expect(job).toMatchObject({
          statusId: status.id,
          applied: false,
          appliedDate: appliedOn,
        });
      }
    },
  );

  it("forward-only matches the status value, not its label (D-016 a)", async () => {
    const lookalike = await prisma.jobStatus.create({
      data: { label: "Draft", value: "draft-lookalike" },
    });
    const pkg = await mk("pending", { emailTo: null });
    await prisma.job.update({
      where: { id: pkg.jobId },
      data: { statusId: lookalike.id },
    });
    await markPackageAppliedManually(userA, pkg.id);
    expect(
      await prisma.job.findUniqueOrThrow({ where: { id: pkg.jobId } }),
    ).toMatchObject({ statusId: lookalike.id, applied: false });
  });

  it("mark applied manually is refused when emailTo is set", async () => {
    const pkg = await mk("pending", { emailTo: "hr@example.com" });
    await expect(
      markPackageAppliedManually(userA, pkg.id),
    ).rejects.toMatchObject(code("INVALID_STATE"));
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: pkg.jobId },
    });
    expect(job.applied).toBe(false);
  });
});

describe("updatePackageContent", () => {
  const cv = {
    name: "Jane Doe",
    experience: [{ bullets: ["a", "b"] }],
    years: 3,
  };

  it("edits fields, keeps the status, sets editedAt, normalizes empty emailTo", async () => {
    const pkg = await mk("approved");
    const res = await updatePackageContent(userA, pkg.id, {
      emailTo: "",
      emailSubject: "New subject",
      letterMd: "Dear team",
    });
    expect(res).toMatchObject({
      status: "approved",
      emailTo: null,
      emailSubject: "New subject",
      letterMd: "Dear team",
      cvPdfStale: false,
    });
    expect(res.editedAt).toBeInstanceOf(Date);
  });

  it("marks the PDF stale only when a CV string changed", async () => {
    const pkg = await mk("pending", { cvJson: JSON.stringify(cv) });
    const same = await updatePackageContent(userA, pkg.id, { cvJson: cv });
    expect(same.cvPdfStale).toBe(false);
    const changed = await updatePackageContent(userA, pkg.id, {
      cvJson: { ...cv, experience: [{ bullets: ["a", "c"] }] },
    });
    expect(changed.cvPdfStale).toBe(true);
    expect(JSON.parse(changed.cvJson ?? "{}").experience[0].bullets[1]).toBe(
      "c",
    );
    // Stale stays set after a later content-neutral edit.
    expect(
      (await updatePackageContent(userA, pkg.id, { emailBody: "x" }))
        .cvPdfStale,
    ).toBe(true);
  });

  it.each([
    ["added key", { ...cv, extra: "x" }],
    ["removed key", { name: "Jane Doe", experience: cv.experience }],
    ["array length", { ...cv, experience: [{ bullets: ["a"] }] }],
    ["non-string value", { ...cv, years: 4 }],
    ["type change", { ...cv, name: 1 }],
  ])("rejects a cvJson whose shape differs: %s", async (_n, next) => {
    const pkg = await mk("pending", { cvJson: JSON.stringify(cv) });
    await expect(
      updatePackageContent(userA, pkg.id, { cvJson: next }),
    ).rejects.toMatchObject(code("VALIDATION"));
    expect((await row(pkg.id)).cvJson).toBe(JSON.stringify(cv));
  });

  it.each([
    ["a stored __proto__ key vs a renamed key", '{"__proto__":{}}', { other: {} }],
    ["a stored toString key vs a renamed key", '{"toString":"x"}', { other: "x" }],
    ["a renamed key vs an inherited name", '{"x":{}}', { constructor: {} }],
  ])("compares own keys only: %s (review 01 #10)", async (_n, stored, next) => {
    const pkg = await mk("pending", { cvJson: stored });
    await expect(
      updatePackageContent(userA, pkg.id, { cvJson: next }),
    ).rejects.toMatchObject(code("VALIDATION"));
    expect((await row(pkg.id)).cvJson).toBe(stored);
  });

  it("keeps empty arrays / objects in the shape", async () => {
    const stored = { a: [], b: {} };
    const pkg = await mk("pending", { cvJson: JSON.stringify(stored) });
    await expect(
      updatePackageContent(userA, pkg.id, { cvJson: { a: {}, b: [] } }),
    ).rejects.toMatchObject(code("VALIDATION"));
    const same = await updatePackageContent(userA, pkg.id, { cvJson: stored });
    expect(same.cvPdfStale).toBe(false);
  });

  it("keeps the PDF stale after an edit is reverted (conservative, documented)", async () => {
    const pkg = await mk("pending", { cvJson: JSON.stringify(cv) });
    const edited = { ...cv, name: "Jane Q. Doe" };
    await updatePackageContent(userA, pkg.id, { cvJson: edited });
    const reverted = await updatePackageContent(userA, pkg.id, { cvJson: cv });
    expect(reverted.cvJson).toBe(JSON.stringify(cv));
    expect(reverted.cvPdfStale).toBe(true);
  });

  it.each([
    ["NBSP-only subject", { emailSubject: "  " }],
    ["ideographic-space subject", { emailSubject: "　" }],
    ["NBSP / line-separator body", { emailBody: "  \n" }],
    ["BOM-only body", { emailBody: "﻿" }],
    ["misspelled key", { emailSubjct: "Typo" }],
  ])("edit refuses a %s and leaves the package unchanged (review 01 #5, #6)", async (_n, patch) => {
    const pkg = await mk("pending");
    const before = await row(pkg.id);
    await expect(
      updatePackageContent(userA, pkg.id, patch),
    ).rejects.toMatchObject(code("VALIDATION"));
    expect(await row(pkg.id)).toEqual(before);
  });

  it("rejects cvJson when none is stored, and invalid fields", async () => {
    const pkg = await mk("pending");
    await expect(
      updatePackageContent(userA, pkg.id, { cvJson: cv }),
    ).rejects.toMatchObject(code("VALIDATION"));
    await expect(updatePackageContent(userA, pkg.id, {})).rejects.toMatchObject(
      code("VALIDATION"),
    );
    await expect(
      updatePackageContent(userA, pkg.id, {
        emailSubject: "a\nBcc: x@example.com",
      }),
    ).rejects.toMatchObject(code("VALIDATION"));
  });
});

describe("queries", () => {
  it("lists the user's packages for a tab, newest first, and nobody else's", async () => {
    const older = await mk("pending", {
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newer = await mk("approved", {
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    const other = await mk("pending", {}, userB);
    const changes = await mk("changes_requested");

    const todo = (await listPackagesByTab(userA, "todo")).map((p) => p.id);
    expect(todo.indexOf(newer.id)).toBeLessThan(todo.indexOf(older.id));
    expect(todo).not.toContain(other.id);
    expect(todo).not.toContain(changes.id);
    expect(
      (await listPackagesByTab(userA, "changes")).map((p) => p.id),
    ).toContain(changes.id);
    expect((await listPackagesByTab(userB, "todo")).map((p) => p.id)).toContain(
      other.id,
    );
    const first = (await listPackagesByTab(userA, "todo"))[0];
    expect(first.job.Company.label).toBe("Example Corp");
  });

  it("getPackageWithJob is user-scoped", async () => {
    const pkg = await mk("pending");
    expect((await getPackageWithJob(userA, pkg.id)).job.id).toBe(pkg.jobId);
    await expect(getPackageWithJob(userB, pkg.id)).rejects.toMatchObject(
      code("NOT_FOUND"),
    );
  });

  it("listJobVersions is user-scoped, newest first", async () => {
    const jobId = await newJob(userA);
    await mk("superseded", { jobId, version: 1 });
    await mk("pending", { jobId, version: 2 });
    expect((await listJobVersions(userA, jobId)).map((v) => v.version)).toEqual(
      [2, 1],
    );
    expect(await listJobVersions(userB, jobId)).toEqual([]);
  });
});
