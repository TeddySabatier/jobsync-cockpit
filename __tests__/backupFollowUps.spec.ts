// @vitest-environment node
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { seedAccount } from "./helpers/backupTestDb";

// D-030: follow-up state (kind, replyToPackageId, messageIdHeader, JobFollowUp)
// travels in format version 2 backups; version 1 backups still import. Real
// SQLite, synthetic data only.

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});
vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const originalUploads = APP_CONSTANTS.UPLOADS_DIR;

beforeAll(() => {
  const uploadsDir = path.join(ctx.dir, "uploads");
  fs.mkdirSync(path.join(uploadsDir, "files", "resumes"), { recursive: true });
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploadsDir;
}, 120_000);

afterAll(async () => {
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await prisma.$disconnect();
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

const T1 = new Date("2026-03-01T09:00:00.000Z");
const T2 = new Date("2026-03-08T09:00:00.000Z");
const T3 = new Date("2026-03-09T09:00:00.000Z");
const MISSING = "00000000-0000-4000-8000-000000000000";

// A job with a sent application (v1) and its Gmail record, a sent follow-up 1
// (kind follow_up, also v1) and a follow-up 2 draft (v2), plus the job state.
async function seedThread(email: string) {
  const userId = await seedAccount(prisma, email);
  const company = await prisma.company.create({
    data: { label: "Acme", value: "acme", createdBy: userId },
  });
  const title = await prisma.jobTitle.create({
    data: { label: "Engineer", value: "engineer", createdBy: userId },
  });
  const status = await prisma.jobStatus.findFirstOrThrow({ where: { value: "applied" } });
  const job = await prisma.job.create({
    data: {
      userId,
      description: "A job",
      jobType: "full-time",
      createdAt: new Date(),
      statusId: status.id,
      jobTitleId: title.id,
      companyId: company.id,
    },
  });
  const base = {
    userId,
    jobId: job.id,
    emailTo: "hiring@example.com",
    emailBody: "Body",
  };
  const app = await prisma.applicationPackage.create({
    data: { ...base, version: 1, status: "sent", emailSubject: "Application", sentAt: T1, sentVia: "gmail" },
  });
  await prisma.sentEmail.create({
    data: {
      userId,
      packageId: app.id,
      fromAddress: "me@example.com",
      toAddress: "hiring@example.com",
      gmailMessageId: "gm-1",
      threadId: "th-1",
      messageIdHeader: "<abc123@example.com>",
      sentAt: T1,
    },
  });
  const fu1 = await prisma.applicationPackage.create({
    data: {
      ...base,
      version: 1,
      kind: "follow_up",
      replyToPackageId: app.id,
      status: "sent",
      emailSubject: "Re: Application",
      sentAt: T2,
      sentVia: "gmail",
    },
  });
  const fu2 = await prisma.applicationPackage.create({
    data: {
      ...base,
      version: 2,
      kind: "follow_up",
      replyToPackageId: app.id,
      status: "pending",
      emailSubject: "Re: Application",
    },
  });
  await prisma.jobFollowUp.create({
    data: {
      userId,
      jobId: job.id,
      outcome: "replied",
      outcomeAt: T3,
      stopped: true,
      skippedThrough: 1,
      skippedAt: T2,
      snoozedUntil: T3,
    },
  });
  return { userId, jobId: job.id, appId: app.id, fu1Id: fu1.id, fu2Id: fu2.id };
}

type Json = Record<string, any>;
const dataOf = async (zip: JSZip) =>
  JSON.parse(await zip.file("data.json")!.async("string")) as Json;
const manifestOf = async (zip: JSZip) =>
  JSON.parse(await zip.file("manifest.json")!.async("string")) as Json;
const rezip = async (zip: JSZip, data: Json, formatVersion?: number) => {
  zip.file("data.json", JSON.stringify(data));
  if (formatVersion !== undefined) {
    const m = await manifestOf(zip);
    zip.file("manifest.json", JSON.stringify({ ...m, formatVersion }));
  }
  return zip.generateAsync({ type: "nodebuffer" });
};

// What a version 1 build wrote: no follow-up fields, no JobFollowUp group, and
// no follow-up package (a version 1 build had none).
function asVersion1(data: Json) {
  const out = { ...data };
  delete out.JobFollowUp;
  out.ApplicationPackage = data.ApplicationPackage.filter(
    (p: Json) => p.kind === "application",
  ).map(({ kind: _k, replyToPackageId: _r, ...rest }: Json) => rest);
  out.SentEmail = data.SentEmail.map(({ messageIdHeader: _m, ...rest }: Json) => rest);
  return out;
}

describe("backup export carries follow-up state (format version 2)", () => {
  it("writes formatVersion 2, the new columns and the JobFollowUp group, without userId", async () => {
    const mine = await seedThread("fu-mine@example.com");
    await seedThread("fu-other@example.com");
    const { buffer } = await buildBackupZip(mine.userId, "fu-mine@example.com");
    const zip = await JSZip.loadAsync(buffer);
    expect((await manifestOf(zip)).formatVersion).toBe(2);
    const data = await dataOf(zip);
    expect(data.JobFollowUp).toHaveLength(1);
    expect(data.JobFollowUp[0]).not.toHaveProperty("userId");
    expect(data.JobFollowUp[0]).toMatchObject({ jobId: mine.jobId, outcome: "replied", stopped: true });
    expect(data.ApplicationPackage.map((p: Json) => p.kind).sort()).toEqual([
      "application",
      "follow_up",
      "follow_up",
    ]);
    expect(data.SentEmail[0].messageIdHeader).toBe("<abc123@example.com>");
  });
});

describe("backup import restores follow-up state", () => {
  it("round trip: kinds, versions per kind, reply link remapped, Message-ID and job state kept", async () => {
    const src = await seedThread("fu-src@example.com");
    const { buffer } = await buildBackupZip(src.userId, "fu-src@example.com");
    const dst = await seedAccount(prisma, "fu-dst@example.com");

    const result = await importBackup(buffer, dst, "fu-dst@example.com", false);
    expect(result.counts.JobFollowUp).toBe(1);
    expect(result.counts.ApplicationPackage).toBe(3);

    const pkgs = await prisma.applicationPackage.findMany({
      where: { userId: dst },
      orderBy: [{ kind: "asc" }, { version: "asc" }],
    });
    expect(pkgs.map((p) => [p.kind, p.version, p.status])).toEqual([
      ["application", 1, "sent"],
      ["follow_up", 1, "sent"],
      ["follow_up", 2, "pending"],
    ]);
    const app = pkgs[0];
    expect(app.id).not.toBe(src.appId);
    expect(pkgs[1].replyToPackageId).toBe(app.id);
    expect(pkgs[2].replyToPackageId).toBe(app.id);
    expect(pkgs[1].sentAt?.toISOString()).toBe(T2.toISOString());

    const sent = await prisma.sentEmail.findFirstOrThrow({ where: { userId: dst } });
    expect(sent.packageId).toBe(app.id);
    expect(sent.messageIdHeader).toBe("<abc123@example.com>");

    const state = await prisma.jobFollowUp.findFirstOrThrow({ where: { userId: dst } });
    expect(state.jobId).toBe(app.jobId);
    expect(state.jobId).not.toBe(src.jobId);
    expect(state).toMatchObject({ outcome: "replied", stopped: true, skippedThrough: 1 });
    expect(state.outcomeAt?.toISOString()).toBe(T3.toISOString());
    expect(state.skippedAt?.toISOString()).toBe(T2.toISOString());
    expect(state.snoozedUntil?.toISOString()).toBe(T3.toISOString());
    // The source account is untouched.
    expect(await prisma.jobFollowUp.count({ where: { userId: src.userId } })).toBe(1);
  });

  it("restoring over an account that has follow-up state replaces it (JobFollowUp wiped before its Job)", async () => {
    const a = await seedThread("fu-over@example.com");
    const { buffer } = await buildBackupZip(a.userId, "fu-over@example.com");
    const result = await importBackup(buffer, a.userId, "fu-over@example.com", true);
    expect(result.snapshotPath).toBeTruthy();
    const snapshot = await dataOf(await JSZip.loadAsync(fs.readFileSync(result.snapshotPath!)));
    expect(snapshot.JobFollowUp).toHaveLength(1);
    const rows = await prisma.jobFollowUp.findMany({ where: { userId: a.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].jobId).not.toBe(a.jobId);
    expect(await prisma.applicationPackage.count({ where: { userId: a.userId } })).toBe(3);
  });

  it("a version 1 backup (no kind, no Message-ID, no JobFollowUp group) imports: everything is an application, no follow-up state", async () => {
    const src = await seedThread("fu-v1@example.com");
    const { buffer } = await buildBackupZip(src.userId, "fu-v1@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const v1 = await rezip(zip, asVersion1(await dataOf(zip)), 1);

    const dst = await seedAccount(prisma, "fu-v1dst@example.com");
    const result = await importBackup(v1, dst, "fu-v1dst@example.com", false);
    expect(result.counts.ApplicationPackage).toBe(1);
    expect(result.counts.JobFollowUp).toBe(0);
    const pkgs = await prisma.applicationPackage.findMany({ where: { userId: dst } });
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]).toMatchObject({ kind: "application", replyToPackageId: null, version: 1, status: "sent" });
    expect((await prisma.sentEmail.findFirstOrThrow({ where: { userId: dst } })).messageIdHeader).toBeNull();
    expect(await prisma.jobFollowUp.count({ where: { userId: dst } })).toBe(0);
  });

  it("a version 1 backup restored over an account with follow-ups wipes them cleanly", async () => {
    const a = await seedThread("fu-v1over@example.com");
    const { buffer } = await buildBackupZip(a.userId, "fu-v1over@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const v1 = await rezip(zip, asVersion1(await dataOf(zip)), 1);
    await importBackup(v1, a.userId, "fu-v1over@example.com", true);
    expect(await prisma.jobFollowUp.count({ where: { userId: a.userId } })).toBe(0);
    expect(await prisma.applicationPackage.count({ where: { userId: a.userId } })).toBe(1);
  });

  it("a reply link to a package that is not in the file restores as null", async () => {
    const src = await seedThread("fu-dangling@example.com");
    const { buffer } = await buildBackupZip(src.userId, "fu-dangling@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    for (const p of data.ApplicationPackage) {
      if (p.kind === "follow_up") p.replyToPackageId = MISSING;
    }
    const dst = await seedAccount(prisma, "fu-dangling-dst@example.com");
    await importBackup(await rezip(zip, data), dst, "fu-dangling-dst@example.com", false);
    const fus = await prisma.applicationPackage.findMany({ where: { userId: dst, kind: "follow_up" } });
    expect(fus).toHaveLength(2);
    expect(fus.every((p) => p.replyToPackageId === null)).toBe(true);
  });

  it.each([
    ["an unknown kind", (d: Json) => (d.ApplicationPackage[0].kind = "draft")],
    ["an unknown outcome", (d: Json) => (d.JobFollowUp[0].outcome = "ghosted")],
    ["skippedThrough out of range", (d: Json) => (d.JobFollowUp[0].skippedThrough = 7)],
    ["a follow-up state row for a job not in the file", (d: Json) => (d.JobFollowUp[0].jobId = MISSING)],
  ])("refuses %s and imports nothing", async (_name, mutate) => {
    const src = await seedThread(`fu-bad-${Math.random().toString(36).slice(2)}@example.com`);
    const { buffer } = await buildBackupZip(src.userId, "x@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    mutate(data);
    const dst = await seedAccount(prisma, `fu-baddst-${Math.random().toString(36).slice(2)}@example.com`);
    await expect(importBackup(await rezip(zip, data), dst, "x@example.com", false)).rejects.toThrow();
    expect(await prisma.jobFollowUp.count({ where: { userId: dst } })).toBe(0);
    expect(await prisma.applicationPackage.count({ where: { userId: dst } })).toBe(0);
  });
});
