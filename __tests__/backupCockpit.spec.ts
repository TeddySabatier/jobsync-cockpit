// @vitest-environment node
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { cockpitUserDir, resolveCockpitFile } from "@/lib/cockpit/files";
import { seedAccount } from "./helpers/backupTestDb";

// D-012: cockpit packages, sent emails and their CV PDFs travel in backups;
// Gmail tokens never do (AC-39). Real SQLite, real files, synthetic data only.

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
const PDF = Buffer.from("%PDF-1.4\n% synthetic cockpit cv\n%%EOF\n");
const SECRET_TOKEN = "SECRET-CIPHERTEXT-123";
const SECRET_IV = "SECRET-IV-456";

let uploadsDir: string;

beforeAll(() => {
  uploadsDir = path.join(ctx.dir, "uploads");
  fs.mkdirSync(path.join(uploadsDir, "files", "resumes"), { recursive: true });
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploadsDir;
}, 120_000);

afterAll(async () => {
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await prisma.$disconnect();
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

async function seedCockpit(email: string) {
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

  const dir = cockpitUserDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${randomUUID()}.pdf`);
  fs.writeFileSync(filePath, PDF);
  const file = await prisma.file.create({
    data: { fileName: "Jane_Doe_CV.pdf", filePath, fileType: "application/pdf" },
  });

  const sentAt = new Date("2026-01-02T03:04:05.000Z");
  const pkg = await prisma.applicationPackage.create({
    data: {
      userId,
      jobId: job.id,
      version: 1,
      status: "sent",
      emailTo: "hiring@example.com",
      emailSubject: "Application",
      emailBody: "Body",
      letterMd: "Letter",
      fitGrade: "A",
      fitAnalysis: '{"summary":"ok"}',
      cvJson: '{"name":"Jane Doe"}',
      cvFileId: file.id,
      idempotencyKey: "key-1",
      sentAt,
      sentVia: "gmail",
    },
  });
  await prisma.sentEmail.create({
    data: {
      userId,
      packageId: pkg.id,
      fromAddress: "you@example.com",
      toAddress: "hiring@example.com",
      gmailMessageId: "gm-1",
      threadId: "th-1",
      sentAt,
    },
  });
  await prisma.gmailAccount.create({
    data: {
      userId,
      email: "you@example.com",
      encryptedRefreshToken: SECRET_TOKEN,
      iv: SECRET_IV,
      scopes: "https://www.googleapis.com/auth/gmail.send",
    },
  });
  return { userId, jobId: job.id, pkgId: pkg.id, fileId: file.id, filePath, sentAt };
}

async function dataOf(zip: JSZip) {
  return JSON.parse(await zip.file("data.json")!.async("string")) as Record<string, any>;
}

const entryFor = (zip: JSZip, fileId: string) =>
  Object.keys(zip.files).find((n) => n.startsWith(`files/${fileId}/`) && !zip.files[n].dir)!;

describe("backup export with cockpit data", () => {
  it("carries packages, sent emails and the CV bytes, and never a Gmail token", async () => {
    const src = await seedCockpit("export@example.com");
    const { buffer } = await buildBackupZip(src.userId, "export@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);

    expect(data.ApplicationPackage).toHaveLength(1);
    expect(data.ApplicationPackage[0]).toMatchObject({
      id: src.pkgId,
      jobId: src.jobId,
      cvFileId: src.fileId,
      status: "sent",
      idempotencyKey: "key-1",
    });
    // The owner column never travels; the importer writes it from the session.
    expect(data.ApplicationPackage[0]).not.toHaveProperty("userId");
    expect(data.SentEmail).toHaveLength(1);
    expect(data.SentEmail[0]).not.toHaveProperty("userId");
    expect(data.File.map((f: { id: string }) => f.id)).toContain(src.fileId);

    expect(await zip.file(entryFor(zip, src.fileId))!.async("nodebuffer")).toEqual(PDF);

    // AC-39: not one byte of the Gmail row, in any entry.
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir) continue;
      const text = (await zip.file(name)!.async("nodebuffer")).toString("latin1");
      expect(text, name).not.toContain(SECRET_TOKEN);
      expect(text, name).not.toContain(SECRET_IV);
      expect(text, name).not.toContain("encryptedRefreshToken");
    }
  });

  it("does not export another user's packages or files", async () => {
    const mine = await seedCockpit("mine@example.com");
    const other = await seedCockpit("other@example.com");
    const { buffer } = await buildBackupZip(mine.userId, "mine@example.com");
    const data = await dataOf(await JSZip.loadAsync(buffer));
    expect(data.ApplicationPackage.map((p: { id: string }) => p.id)).toEqual([mine.pkgId]);
    expect(data.File.map((f: { id: string }) => f.id)).not.toContain(other.fileId);
  });
});

describe("backup import with cockpit data", () => {
  it("restores into an empty account under new ids, with a CV the file route can serve", async () => {
    const src = await seedCockpit("src@example.com");
    const { buffer } = await buildBackupZip(src.userId, "src@example.com");
    const dst = await seedAccount(prisma, "dst@example.com");

    const result = await importBackup(buffer, dst, "dst@example.com", false);
    expect(result.counts.ApplicationPackage).toBe(1);
    expect(result.counts.SentEmail).toBe(1);

    const pkg = await prisma.applicationPackage.findFirstOrThrow({
      where: { userId: dst },
      include: { cvFile: true, job: true, sentEmail: true },
    });
    expect(pkg.id).not.toBe(src.pkgId);
    expect(pkg.job.userId).toBe(dst);
    expect(pkg).toMatchObject({
      version: 1,
      status: "sent",
      emailTo: "hiring@example.com",
      emailSubject: "Application",
      fitGrade: "A",
      idempotencyKey: "key-1",
      sentVia: "gmail",
    });
    expect(pkg.sentAt!.toISOString()).toBe(src.sentAt.toISOString());
    expect(pkg.sentEmail).toMatchObject({
      userId: dst,
      gmailMessageId: "gm-1",
      threadId: "th-1",
      packageId: pkg.id,
    });

    // The CV lives in the importing user's cockpit folder and is readable.
    const file = pkg.cvFile!;
    expect(file.id).not.toBe(src.fileId);
    expect(file.filePath).toBe(path.join(cockpitUserDir(dst), `${file.id}.pdf`));
    expect(fs.readFileSync(file.filePath)).toEqual(PDF);
    expect(await resolveCockpitFile(dst, file)).toBeTruthy();
    // And it is not served to the source user.
    expect(await resolveCockpitFile(src.userId, file)).toBeNull();

    // The source account is untouched, and no Gmail token was created for dst.
    expect(await prisma.applicationPackage.count({ where: { userId: src.userId } })).toBe(1);
    expect(fs.existsSync(src.filePath)).toBe(true);
    expect(await prisma.gmailAccount.count({ where: { userId: dst } })).toBe(0);
  });

  it("restoring over an existing account replaces its packages without orphaning files or rows", async () => {
    const a = await seedCockpit("over@example.com");
    const { buffer } = await buildBackupZip(a.userId, "over@example.com");

    const result = await importBackup(buffer, a.userId, "over@example.com", true);
    expect(result.snapshotPath).toBeTruthy();

    // The snapshot taken before the wipe now contains the packages (the bug:
    // it used to have none, so they were unrecoverable).
    const snapshot = await dataOf(await JSZip.loadAsync(fs.readFileSync(result.snapshotPath!)));
    expect(snapshot.ApplicationPackage).toHaveLength(1);

    const pkgs = await prisma.applicationPackage.findMany({
      where: { userId: a.userId },
      include: { cvFile: true },
    });
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0].id).not.toBe(a.pkgId);
    const newFile = pkgs[0].cvFile!;

    // No orphans: the old row and old bytes are gone, exactly one new CV remains.
    expect(await prisma.file.findUnique({ where: { id: a.fileId } })).toBeNull();
    expect(fs.existsSync(a.filePath)).toBe(false);
    expect(fs.readdirSync(cockpitUserDir(a.userId))).toEqual([`${newFile.id}.pdf`]);
    expect(await prisma.sentEmail.count({ where: { userId: a.userId } })).toBe(1);

    // The Gmail connection is not part of a restore: it is kept, not wiped.
    const gmail = await prisma.gmailAccount.findUniqueOrThrow({ where: { userId: a.userId } });
    expect(gmail.encryptedRefreshToken).toBe(SECRET_TOKEN);
  });

  it("still imports a backup written before cockpit data existed", async () => {
    const src = await seedCockpit("old@example.com");
    const { buffer } = await buildBackupZip(src.userId, "old@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    delete data.ApplicationPackage;
    delete data.SentEmail;
    data.File = [];
    zip.remove(entryFor(zip, src.fileId));
    zip.file("data.json", JSON.stringify(data));
    const old = await zip.generateAsync({ type: "nodebuffer" });

    const dst = await seedAccount(prisma, "olddst@example.com");
    const result = await importBackup(old, dst, "olddst@example.com", false);
    expect(result.counts.Job).toBe(1);
    expect(result.counts.ApplicationPackage).toBe(0);
    expect(await prisma.job.count({ where: { userId: dst } })).toBe(1);
    expect(await prisma.applicationPackage.count({ where: { userId: dst } })).toBe(0);
  });

  it("keeps the package but drops CV bytes that are not a PDF", async () => {
    const src = await seedCockpit("bad@example.com");
    const { buffer } = await buildBackupZip(src.userId, "bad@example.com");
    const zip = await JSZip.loadAsync(buffer);
    zip.file(entryFor(zip, src.fileId), Buffer.from("this is not a pdf"));
    const tampered = await zip.generateAsync({ type: "nodebuffer" });

    const dst = await seedAccount(prisma, "baddst@example.com");
    await importBackup(tampered, dst, "baddst@example.com", false);
    const pkg = await prisma.applicationPackage.findFirstOrThrow({
      where: { userId: dst },
      include: { cvFile: true },
    });
    expect(pkg.cvFile).toBeTruthy();
    expect(fs.existsSync(pkg.cvFile!.filePath)).toBe(false);
    expect(pkg.cvFile!.filePath.startsWith(cockpitUserDir(dst) + path.sep)).toBe(true);
  });

  it("never takes the CV path from the payload", async () => {
    const src = await seedCockpit("path@example.com");
    const { buffer } = await buildBackupZip(src.userId, "path@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    data.File = data.File.map((f: { filePath: string }) => ({ ...f, filePath: "../../../../etc/passwd" }));
    zip.file("data.json", JSON.stringify(data));
    const hostile = await zip.generateAsync({ type: "nodebuffer" });

    const dst = await seedAccount(prisma, "pathdst@example.com");
    await importBackup(hostile, dst, "pathdst@example.com", false);
    const file = await prisma.file.findFirstOrThrow({
      where: { applicationPackages: { some: { userId: dst } } },
    });
    expect(file.filePath).toBe(path.join(cockpitUserDir(dst), `${file.id}.pdf`));
    expect(fs.readFileSync(file.filePath)).toEqual(PDF);
  });

  it("restores a package whose CV row is not in the backup, without a CV, instead of failing", async () => {
    const src = await seedCockpit("dangling@example.com");
    const { buffer } = await buildBackupZip(src.userId, "dangling@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    data.File = [];
    zip.remove(entryFor(zip, src.fileId));
    zip.file("data.json", JSON.stringify(data));
    const broken = await zip.generateAsync({ type: "nodebuffer" });

    const dst = await seedAccount(prisma, "danglingdst@example.com");
    const result = await importBackup(broken, dst, "danglingdst@example.com", false);
    expect(result.counts.ApplicationPackage).toBe(1);
    const pkg = await prisma.applicationPackage.findFirstOrThrow({ where: { userId: dst } });
    expect(pkg.cvFileId).toBeNull();
  });

  it("keeps two package versions pointing at one shared CV file as one file", async () => {
    const src = await seedCockpit("shared@example.com");
    await prisma.applicationPackage.create({
      data: {
        userId: src.userId,
        jobId: src.jobId,
        version: 2,
        status: "pending",
        emailSubject: "Application v2",
        emailBody: "Body v2",
        cvFileId: src.fileId,
      },
    });
    const { buffer } = await buildBackupZip(src.userId, "shared@example.com");
    const dst = await seedAccount(prisma, "shareddst@example.com");
    await importBackup(buffer, dst, "shareddst@example.com", false);

    const pkgs = await prisma.applicationPackage.findMany({
      where: { userId: dst },
      orderBy: { version: "asc" },
    });
    expect(pkgs.map((p) => p.version)).toEqual([1, 2]);
    expect(pkgs[0].cvFileId).toBeTruthy();
    expect(pkgs[1].cvFileId).toBe(pkgs[0].cvFileId);
    expect(fs.readdirSync(cockpitUserDir(dst))).toEqual([`${pkgs[0].cvFileId}.pdf`]);
  });

  it("restores a package whose CV file was missing at export time", async () => {
    const src = await seedCockpit("gone@example.com");
    fs.unlinkSync(src.filePath);
    const { buffer } = await buildBackupZip(src.userId, "gone@example.com");
    const dst = await seedAccount(prisma, "gonedst@example.com");
    await importBackup(buffer, dst, "gonedst@example.com", false);
    const pkg = await prisma.applicationPackage.findFirstOrThrow({
      where: { userId: dst },
      include: { cvFile: true },
    });
    expect(pkg.cvFile).toBeTruthy();
    expect(await resolveCockpitFile(dst, pkg.cvFile!)).toBeNull();
  });
});
