// @vitest-environment node
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { seedAccount } from "./helpers/backupTestDb";

// Issue #77 / D-028: the send history travels in backups (D-012/D-017), is
// wiped children-first on restore, and old backups import with none. Real
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

const T1 = new Date("2026-02-03T04:05:06.000Z");
const T2 = new Date("2026-02-03T04:05:07.000Z");
const T3 = new Date("2026-02-03T04:06:00.000Z");

// A package with a three-entry history: a definitive failure, an ambiguous
// outcome, then Gmail accepting a later attempt (the id is kept).
async function seedHistory(email: string) {
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
  const pkg = await prisma.applicationPackage.create({
    data: {
      userId,
      jobId: job.id,
      version: 1,
      status: "sent",
      emailTo: "hiring@example.com",
      emailSubject: "Application",
      emailBody: "Body",
      sentAt: T3,
      sentVia: "gmail",
    },
  });
  await prisma.sendAttempt.createMany({
    data: [
      { userId, packageId: pkg.id, outcome: "failed", errorCode: "GMAIL_SEND", createdAt: T1 },
      { userId, packageId: pkg.id, outcome: "ambiguous", errorCode: "GMAIL_TIMEOUT", createdAt: T2 },
      {
        userId,
        packageId: pkg.id,
        outcome: "sent",
        gmailMessageId: "gm-9",
        threadId: "th-9",
        createdAt: T3,
      },
    ],
  });
  return { userId, pkgId: pkg.id };
}

const dataOf = async (zip: JSZip) =>
  JSON.parse(await zip.file("data.json")!.async("string")) as Record<string, any>;

const historyOf = (userId: string) =>
  prisma.sendAttempt.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

describe("backup export carries the send history", () => {
  it("exports the attempts of the user only, without userId", async () => {
    const mine = await seedHistory("hist-mine@example.com");
    await seedHistory("hist-other@example.com");
    const { buffer } = await buildBackupZip(mine.userId, "hist-mine@example.com");
    const data = await dataOf(await JSZip.loadAsync(buffer));
    expect(data.SendAttempt).toHaveLength(3);
    for (const a of data.SendAttempt) {
      expect(a).not.toHaveProperty("userId");
      expect(a.packageId).toBe(mine.pkgId);
    }
    expect(data.SendAttempt.map((a: { outcome: string }) => a.outcome).sort()).toEqual([
      "ambiguous",
      "failed",
      "sent",
    ]);
  });
});

describe("backup import restores the send history", () => {
  it("round trip into an empty account: new ids, package link remapped, fields and times kept", async () => {
    const src = await seedHistory("hist-src@example.com");
    const { buffer } = await buildBackupZip(src.userId, "hist-src@example.com");
    const dst = await seedAccount(prisma, "hist-dst@example.com");

    const result = await importBackup(buffer, dst, "hist-dst@example.com", false);
    expect(result.counts.SendAttempt).toBe(3);

    const pkg = await prisma.applicationPackage.findFirstOrThrow({ where: { userId: dst } });
    const rows = await historyOf(dst);
    expect(rows.map((r) => r.outcome)).toEqual(["failed", "ambiguous", "sent"]);
    expect(rows.map((r) => r.errorCode)).toEqual(["GMAIL_SEND", "GMAIL_TIMEOUT", null]);
    expect(rows[2]).toMatchObject({ gmailMessageId: "gm-9", threadId: "th-9" });
    expect(rows.map((r) => r.createdAt.toISOString())).toEqual([
      T1.toISOString(),
      T2.toISOString(),
      T3.toISOString(),
    ]);
    for (const r of rows) {
      expect(r.packageId).toBe(pkg.id);
      expect(r.packageId).not.toBe(src.pkgId);
      expect(r.userId).toBe(dst);
    }
    // The source account is untouched.
    expect(await prisma.sendAttempt.count({ where: { userId: src.userId } })).toBe(3);
  });

  it("restoring over an account that has a history replaces it (children wiped before parents)", async () => {
    const a = await seedHistory("hist-over@example.com");
    const { buffer } = await buildBackupZip(a.userId, "hist-over@example.com");
    // A later attempt that is not in the backup disappears with the wipe.
    await prisma.sendAttempt.create({
      data: { userId: a.userId, packageId: a.pkgId, outcome: "lock_released" },
    });
    expect(await prisma.sendAttempt.count({ where: { userId: a.userId } })).toBe(4);

    const result = await importBackup(buffer, a.userId, "hist-over@example.com", true);
    expect(result.snapshotPath).toBeTruthy();
    // The rollback snapshot taken before the wipe holds all four attempts.
    const snapshot = await dataOf(await JSZip.loadAsync(fs.readFileSync(result.snapshotPath!)));
    expect(snapshot.SendAttempt).toHaveLength(4);

    const rows = await historyOf(a.userId);
    expect(rows.map((r) => r.outcome)).toEqual(["failed", "ambiguous", "sent"]);
    const pkg = await prisma.applicationPackage.findFirstOrThrow({ where: { userId: a.userId } });
    expect(pkg.id).not.toBe(a.pkgId);
    expect(rows.every((r) => r.packageId === pkg.id)).toBe(true);
    // No orphans anywhere.
    expect(await prisma.sendAttempt.count({ where: { packageId: a.pkgId } })).toBe(0);
  });

  it("an old backup with no SendAttempt group imports with an empty history", async () => {
    const src = await seedHistory("hist-old@example.com");
    const { buffer } = await buildBackupZip(src.userId, "hist-old@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    delete data.SendAttempt;
    zip.file("data.json", JSON.stringify(data));
    const old = await zip.generateAsync({ type: "nodebuffer" });

    const dst = await seedAccount(prisma, "hist-olddst@example.com");
    const result = await importBackup(old, dst, "hist-olddst@example.com", false);
    expect(result.counts.ApplicationPackage).toBe(1);
    expect(result.counts.SendAttempt).toBe(0);
    expect(await prisma.sendAttempt.count({ where: { userId: dst } })).toBe(0);
    expect(await prisma.applicationPackage.count({ where: { userId: dst } })).toBe(1);
  });

  it("an old backup restored over an account with a history wipes it cleanly", async () => {
    const a = await seedHistory("hist-oldover@example.com");
    const { buffer } = await buildBackupZip(a.userId, "hist-oldover@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    delete data.SendAttempt;
    zip.file("data.json", JSON.stringify(data));
    const old = await zip.generateAsync({ type: "nodebuffer" });

    await importBackup(old, a.userId, "hist-oldover@example.com", true);
    expect(await prisma.sendAttempt.count({ where: { userId: a.userId } })).toBe(0);
    expect(await prisma.applicationPackage.count({ where: { userId: a.userId } })).toBe(1);
  });

  it("refuses a history row that points at a package not in the file", async () => {
    const src = await seedHistory("hist-bad@example.com");
    const { buffer } = await buildBackupZip(src.userId, "hist-bad@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    data.SendAttempt[0].packageId = "00000000-0000-4000-8000-000000000000";
    zip.file("data.json", JSON.stringify(data));
    const bad = await zip.generateAsync({ type: "nodebuffer" });

    const dst = await seedAccount(prisma, "hist-baddst@example.com");
    await expect(importBackup(bad, dst, "hist-baddst@example.com", false)).rejects.toThrow();
    // Nothing half-imported.
    expect(await prisma.sendAttempt.count({ where: { userId: dst } })).toBe(0);
    expect(await prisma.applicationPackage.count({ where: { userId: dst } })).toBe(0);
  });
});
