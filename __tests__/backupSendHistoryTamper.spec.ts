// @vitest-environment node
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { toSendHistoryView } from "@/lib/cockpit/packageView";
import { seedAccount } from "./helpers/backupTestDb";

// Independent review of #77 / D-028: tampered backups. Real SQLite, synthetic data.

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return { default: new PrismaClient({ datasources: { db: { url: ctx.url } } }) };
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

async function seed(email: string) {
  const userId = await seedAccount(prisma, email);
  const company = await prisma.company.create({ data: { label: "Acme", value: "acme", createdBy: userId } });
  const title = await prisma.jobTitle.create({ data: { label: "Eng", value: "eng", createdBy: userId } });
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
    data: { userId, jobId: job.id, version: 1, status: "sent", emailTo: "h@example.com", emailSubject: "s", emailBody: "b", sentVia: "gmail" },
  });
  const a = await prisma.sendAttempt.create({
    data: { userId, packageId: pkg.id, outcome: "sent", gmailMessageId: "gm", threadId: "th" },
  });
  return { userId, jobId: job.id, pkgId: pkg.id, attemptId: a.id };
}

const tamper = async (buffer: Buffer, fn: (d: Record<string, any>) => void) => {
  const zip = await JSZip.loadAsync(buffer);
  const data = JSON.parse(await zip.file("data.json")!.async("string"));
  fn(data);
  zip.file("data.json", JSON.stringify(data));
  return zip.generateAsync({ type: "nodebuffer" });
};

describe("tampered backups with a send history", () => {
  it("another user's package id (not in the file) is refused and nothing leaks into the victim", async () => {
    const victim = await seed("tam-victim@example.com");
    const attacker = await seed("tam-attacker@example.com");
    const { buffer } = await buildBackupZip(attacker.userId, "tam-attacker@example.com");
    const bad = await tamper(buffer, (d) => {
      d.SendAttempt[0].packageId = victim.pkgId;
    });
    const dst = await seedAccount(prisma, "tam-dst@example.com");
    await expect(importBackup(bad, dst, "tam-dst@example.com", false)).rejects.toThrow();
    expect(await prisma.sendAttempt.count({ where: { packageId: victim.pkgId } })).toBe(1);
    expect(await prisma.sendAttempt.count({ where: { userId: dst } })).toBe(0);
  });

  it("a packageId that is the id of a Job in the file does not import (FK), nothing half-imported", async () => {
    const src = await seed("tam-job@example.com");
    const { buffer } = await buildBackupZip(src.userId, "tam-job@example.com");
    const bad = await tamper(buffer, (d) => {
      d.SendAttempt[0].packageId = d.Job[0].id;
    });
    const dst = await seedAccount(prisma, "tam-jobdst@example.com");
    await expect(importBackup(bad, dst, "tam-jobdst@example.com", false)).rejects.toThrow();
    expect(await prisma.applicationPackage.count({ where: { userId: dst } })).toBe(0);
    expect(await prisma.sendAttempt.count({ where: { userId: dst } })).toBe(0);
  });

  it("a forged userId in the file is ignored; the row belongs to the importing user", async () => {
    const victim = await seed("tam-v2@example.com");
    const src = await seed("tam-s2@example.com");
    const { buffer } = await buildBackupZip(src.userId, "tam-s2@example.com");
    const bad = await tamper(buffer, (d) => {
      d.SendAttempt[0].userId = victim.userId;
    });
    const dst = await seedAccount(prisma, "tam-d2@example.com");
    await importBackup(bad, dst, "tam-d2@example.com", false);
    expect(await prisma.sendAttempt.count({ where: { userId: dst } })).toBe(1);
    expect(await prisma.sendAttempt.count({ where: { userId: victim.userId } })).toBe(1);
  });

  it("the same id as another user's attempt does not collide or overwrite", async () => {
    const victim = await seed("tam-v3@example.com");
    const src = await seed("tam-s3@example.com");
    const { buffer } = await buildBackupZip(src.userId, "tam-s3@example.com");
    const bad = await tamper(buffer, (d) => {
      d.SendAttempt[0].id = victim.attemptId;
    });
    const dst = await seedAccount(prisma, "tam-d3@example.com");
    await importBackup(bad, dst, "tam-d3@example.com", false);
    const v = await prisma.sendAttempt.findUniqueOrThrow({ where: { id: victim.attemptId } });
    expect(v.userId).toBe(victim.userId);
    expect(await prisma.sendAttempt.count({ where: { userId: dst } })).toBe(1);
  });

  it("hostile outcome/errorCode strings import as data and render as no reason", async () => {
    const src = await seed("tam-s4@example.com");
    const { buffer } = await buildBackupZip(src.userId, "tam-s4@example.com");
    const bad = await tamper(buffer, (d) => {
      d.SendAttempt[0].outcome = "<img src=x onerror=alert(1)>";
      d.SendAttempt[0].errorCode = "constructor";
    });
    const dst = await seedAccount(prisma, "tam-d4@example.com");
    await importBackup(bad, dst, "tam-d4@example.com", false);
    const rows = await prisma.sendAttempt.findMany({ where: { userId: dst } });
    const [v] = toSendHistoryView(rows);
    expect(v.reason).toBeNull();
    expect(JSON.stringify(v)).not.toContain("function");
  });

  it("export carries no thread-id leak beyond the backup file and no userId; size per row is small", async () => {
    const src = await seed("tam-s5@example.com");
    const { buffer } = await buildBackupZip(src.userId, "tam-s5@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    expect(JSON.stringify(data.SendAttempt)).not.toContain(src.userId);
    expect(JSON.stringify(data.SendAttempt[0]).length).toBeLessThan(400);
  });
});
