// @vitest-environment node
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import fsp from "fs/promises";
import { importBackup, preflightBackup } from "@/lib/backup/import";
import { cockpitUserDir, resolveCockpitFile } from "@/lib/cockpit/files";
import { releaseSendLock } from "@/lib/cockpit/send";
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

  it("restoring over one account never touches another user's packages, files or bytes", async () => {
    const a = await seedCockpit("victim-a@example.com");
    const b = await seedCockpit("bystander-b@example.com");
    const { buffer } = await buildBackupZip(a.userId, "victim-a@example.com");
    await importBackup(buffer, a.userId, "victim-a@example.com", true);

    expect(await prisma.file.findUnique({ where: { id: b.fileId } })).not.toBeNull();
    expect(fs.readFileSync(b.filePath)).toEqual(PDF);
    expect(await prisma.applicationPackage.findUnique({ where: { id: b.pkgId } })).not.toBeNull();
    expect(await prisma.sentEmail.count({ where: { userId: b.userId } })).toBe(1);
    expect(await prisma.gmailAccount.count({ where: { userId: b.userId } })).toBe(1);
  });

  it("drops a DOCX under a cockpit CV id: cockpit CVs are PDF only", async () => {
    const src = await seedCockpit("docx@example.com");
    const { buffer } = await buildBackupZip(src.userId, "docx@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const docx = new JSZip();
    docx.file("[Content_Types].xml", "<Types/>");
    docx.file("word/document.xml", "<w:document/>");
    zip.file(entryFor(zip, src.fileId), await docx.generateAsync({ type: "nodebuffer" }));
    const tampered = await zip.generateAsync({ type: "nodebuffer" });

    const dst = await seedAccount(prisma, "docxdst@example.com");
    await importBackup(tampered, dst, "docxdst@example.com", false);
    const pkg = await prisma.applicationPackage.findFirstOrThrow({
      where: { userId: dst },
      include: { cvFile: true },
    });
    expect(fs.existsSync(pkg.cvFile!.filePath)).toBe(false);
    expect(fs.readdirSync(cockpitUserDir(dst))).toEqual([]);
  });

  it("a failed import changes nothing: old rows and bytes stay, no new CV bytes are left", async () => {
    const a = await seedCockpit("fail@example.com");
    const { buffer } = await buildBackupZip(a.userId, "fail@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    // A second package with the same job and version breaks a unique
    // constraint in the middle of the transaction.
    data.ApplicationPackage.push({
      ...data.ApplicationPackage[0],
      id: randomUUID(),
      idempotencyKey: null,
    });
    zip.file("data.json", JSON.stringify(data));
    const broken = await zip.generateAsync({ type: "nodebuffer" });

    await expect(
      importBackup(broken, a.userId, "fail@example.com", true),
    ).rejects.toThrow(/nothing was changed/i);

    expect(fs.readFileSync(a.filePath)).toEqual(PDF);
    expect(fs.readdirSync(cockpitUserDir(a.userId))).toEqual([path.basename(a.filePath)]);
    expect(await prisma.file.findUnique({ where: { id: a.fileId } })).not.toBeNull();
    expect(await prisma.applicationPackage.findUnique({ where: { id: a.pkgId } })).not.toBeNull();
    expect(await prisma.sentEmail.count({ where: { userId: a.userId } })).toBe(1);
  });

  // Issue #60 finding 2. A package locked for sending (approved, sendStartedAt
  // set) must not be wiped while the Gmail call may be in flight.
  it("refuses to import while a package is being sent, and changes nothing", async () => {
    const a = await seedCockpit("sending@example.com");
    const { buffer } = await buildBackupZip(a.userId, "sending@example.com");
    await prisma.applicationPackage.update({
      where: { id: a.pkgId },
      data: { status: "approved", sentAt: null, sendStartedAt: new Date() },
    });

    await expect(
      importBackup(buffer, a.userId, "sending@example.com", true),
    ).rejects.toThrow(/being sent/i);

    const pkg = await prisma.applicationPackage.findUniqueOrThrow({ where: { id: a.pkgId } });
    expect(pkg.sendStartedAt).not.toBeNull();
    expect(await prisma.file.findUnique({ where: { id: a.fileId } })).not.toBeNull();
    expect(fs.readdirSync(cockpitUserDir(a.userId))).toEqual([path.basename(a.filePath)]);
    expect(await prisma.sentEmail.count({ where: { userId: a.userId } })).toBe(1);
  }, 30_000);

  // Issue #60 finding 9. A backup can carry a package that was locked at export
  // time. It is restored still locked (the email may have gone out), and the
  // cockpit's recovery actions can release it: the lock is older than the
  // stale-lock window by the time anyone looks.
  it("restores a locked package as locked, and the recovery action can release it", async () => {
    const src = await seedCockpit("locked@example.com");
    await prisma.applicationPackage.update({
      where: { id: src.pkgId },
      data: {
        status: "approved",
        sentAt: null,
        sendStartedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    const { buffer } = await buildBackupZip(src.userId, "locked@example.com");
    const dst = await seedAccount(prisma, "lockeddst@example.com");
    await importBackup(buffer, dst, "lockeddst@example.com", false);

    const pkg = await prisma.applicationPackage.findFirstOrThrow({ where: { userId: dst } });
    expect(pkg.status).toBe("approved");
    expect(pkg.sendStartedAt).not.toBeNull();

    // While it stays locked, a further import over it is refused (finding 2).
    await expect(
      importBackup(buffer, dst, "lockeddst@example.com", true),
    ).rejects.toThrow(/being sent/i);

    await releaseSendLock(dst, pkg.id);
    const released = await prisma.applicationPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    expect(released.sendStartedAt).toBeNull();
    expect(released.status).toBe("approved");
  }, 30_000);

  // Issue #60 finding 1. The restored name must not carry the previous
  // name forward: it used to grow by "<uuid>-" on every export/import cycle
  // until the write failed with ENAMETOOLONG.
  it("keeps resume file names bounded across repeated export/import cycles", async () => {
    const userId = await seedAccount(prisma, "cycles@example.com");
    const profile = await prisma.profile.create({ data: { userId } });
    const longName = `${"a-very-long-resume-name-".repeat(6)}final.pdf`;
    const resumePath = path.join(uploadsDir, "files", "resumes", longName);
    fs.writeFileSync(resumePath, PDF);
    const file = await prisma.file.create({
      data: { fileName: longName, filePath: resumePath, fileType: "application/pdf" },
    });
    await prisma.resume.create({
      data: { profileId: profile.id, title: "CV", FileId: file.id },
    });

    for (let cycle = 0; cycle < 5; cycle++) {
      const { buffer } = await buildBackupZip(userId, "cycles@example.com");
      await importBackup(buffer, userId, "cycles@example.com", true);
      const current = await prisma.file.findFirstOrThrow({
        where: { Resume: { profile: { userId } } },
      });
      expect(path.basename(current.filePath)).toBe(`${current.id}.pdf`);
      expect(fs.readFileSync(current.filePath)).toEqual(PDF);
      // The display name is unchanged.
      expect(current.fileName).toBe(longName);
    }
  }, 30_000);

  // Issue #60 finding 1. A write that throws after other files were written
  // must remove them, report the import as failed and leave the old data.
  it("a failed file write removes the files already written and changes nothing", async () => {
    const userId = await seedAccount(prisma, "writefail@example.com");
    const profile = await prisma.profile.create({ data: { userId } });
    for (const name of ["one.pdf", "two.pdf"]) {
      const p = path.join(uploadsDir, "files", "resumes", `${randomUUID()}-${name}`);
      fs.writeFileSync(p, PDF);
      const f = await prisma.file.create({
        data: { fileName: name, filePath: p, fileType: "application/pdf" },
      });
      await prisma.resume.create({ data: { profileId: profile.id, title: name, FileId: f.id } });
    }
    const { buffer } = await buildBackupZip(userId, "writefail@example.com");
    const resumesDir = path.join(uploadsDir, "files", "resumes");
    const before = fs.readdirSync(resumesDir).sort();
    const oldFileIds = (
      await prisma.file.findMany({ where: { Resume: { profile: { userId } } } })
    ).map((f) => f.id);

    // The second resume write fails; the snapshot write is let through.
    const realWrite = fsp.writeFile;
    let calls = 0;
    const spy = vi.spyOn(fsp, "writeFile").mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]).startsWith(resumesDir + path.sep)) {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return (realWrite as (...a: unknown[]) => Promise<void>)(...args);
    }) as typeof fsp.writeFile);
    try {
      await expect(
        importBackup(buffer, userId, "writefail@example.com", true),
      ).rejects.toThrow(/nothing was changed/i);
    } finally {
      spy.mockRestore();
    }

    expect(calls).toBe(2);
    expect(fs.readdirSync(resumesDir).sort()).toEqual(before);
    const after = await prisma.file.findMany({
      where: { Resume: { profile: { userId } } },
    });
    expect(after.map((f) => f.id).sort()).toEqual([...oldFileIds].sort());
  }, 30_000);

  // Issue #60 finding 3. The confirmation lists what is replaced, cockpit
  // data included; those rows do not change whether the account is empty.
  it("preflight counts packages, sent emails and files on the target", async () => {
    const a = await seedCockpit("counts@example.com");
    const { buffer } = await buildBackupZip(a.userId, "counts@example.com");
    const result = await preflightBackup(buffer, a.userId, "counts@example.com");
    expect(result.targetCounts).toMatchObject({
      Job: 1,
      ApplicationPackage: 1,
      SentEmail: 1,
      File: 1,
    });
    expect(result.targetIsEmpty).toBe(false);

    const empty = await seedAccount(prisma, "countsempty@example.com");
    const fresh = await preflightBackup(buffer, empty, "countsempty@example.com");
    expect(fresh.targetIsEmpty).toBe(true);
  }, 30_000);

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

// Issue #60, independent tester additions (PR #69): seams and data-loss cases
// the PR's own specs do not pin down.
describe("backup import hardening (issue #60, tester)", () => {
  const resumesDir = () => path.join(uploadsDir, "files", "resumes");

  async function seedResume(userId: string, profileId: string, diskName: string, displayName: string, bytes: Buffer) {
    const p = path.join(resumesDir(), diskName);
    fs.writeFileSync(p, bytes);
    const f = await prisma.file.create({
      data: { fileName: displayName, filePath: p, fileType: "application/pdf" },
    });
    await prisma.resume.create({ data: { profileId, title: displayName, FileId: f.id } });
    return { fileId: f.id, filePath: p };
  }

  // The in-transaction check is the only thing that stops a send which takes
  // its lock after the early check. The snapshot write sits between the two,
  // so the lock is taken there.
  it("refuses an import when a send locks between the early check and the transaction", async () => {
    const a = await seedCockpit("race@example.com");
    await prisma.applicationPackage.update({
      where: { id: a.pkgId },
      data: { status: "approved", sentAt: null, sentVia: null, sendStartedAt: null },
    });
    const { buffer } = await buildBackupZip(a.userId, "race@example.com");
    const backupsDir = path.join(uploadsDir, "backups");

    const realWrite = fsp.writeFile;
    let locked = false;
    const spy = vi.spyOn(fsp, "writeFile").mockImplementation((async (...args: unknown[]) => {
      const result = await (realWrite as (...a: unknown[]) => Promise<void>)(...args);
      if (!locked && String(args[0]).startsWith(backupsDir + path.sep)) {
        locked = true;
        await prisma.applicationPackage.update({
          where: { id: a.pkgId },
          data: { sendStartedAt: new Date() },
        });
      }
      return result;
    }) as typeof fsp.writeFile);
    try {
      await expect(
        importBackup(buffer, a.userId, "race@example.com", true),
      ).rejects.toThrow(/being sent/i);
    } finally {
      spy.mockRestore();
    }

    expect(locked).toBe(true);
    const pkg = await prisma.applicationPackage.findUniqueOrThrow({ where: { id: a.pkgId } });
    expect(pkg.status).toBe("approved");
    expect(pkg.sendStartedAt).not.toBeNull();
    expect(await prisma.file.findUnique({ where: { id: a.fileId } })).not.toBeNull();
    expect(fs.readFileSync(a.filePath)).toEqual(PDF);
    // The CV bytes the import had already written were removed.
    expect(fs.readdirSync(cockpitUserDir(a.userId))).toEqual([path.basename(a.filePath)]);
    expect(await prisma.sentEmail.count({ where: { userId: a.userId } })).toBe(1);
  }, 30_000);

  it("refuses an import over a lock whose outcome is unknown, even when it is stale", async () => {
    const a = await seedCockpit("unknown@example.com");
    const { buffer } = await buildBackupZip(a.userId, "unknown@example.com");
    await prisma.applicationPackage.update({
      where: { id: a.pkgId },
      data: {
        status: "approved",
        sentAt: null,
        sendStartedAt: new Date(Date.now() - 24 * 3_600_000),
        sendOutcome: "unknown",
      },
    });
    const snapDir = path.join(uploadsDir, "backups", a.userId);
    await expect(
      importBackup(buffer, a.userId, "unknown@example.com", true),
    ).rejects.toThrow(/being sent/i);
    expect(await prisma.applicationPackage.findUnique({ where: { id: a.pkgId } })).not.toBeNull();
    // Refused before the snapshot: a refused import must not write one (each
    // snapshot write prunes the oldest kept snapshot).
    expect(fs.existsSync(snapDir) ? fs.readdirSync(snapDir) : []).toEqual([]);
  }, 30_000);

  // A successful Gmail send sets status "sent" but leaves sendStartedAt in
  // place (send.ts step 6). That history must not block a restore forever.
  it("does not refuse an import because a sent package kept its sendStartedAt", async () => {
    const a = await seedCockpit("sentlock@example.com");
    await prisma.applicationPackage.update({
      where: { id: a.pkgId },
      data: { sendStartedAt: new Date() },
    });
    const { buffer } = await buildBackupZip(a.userId, "sentlock@example.com");
    const result = await importBackup(buffer, a.userId, "sentlock@example.com", true);
    expect(result.counts.ApplicationPackage).toBe(1);
  }, 30_000);

  it("does not let another user's in-flight send block this user's import", async () => {
    const mine = await seedCockpit("notmine-a@example.com");
    const other = await seedCockpit("notmine-b@example.com");
    await prisma.applicationPackage.update({
      where: { id: other.pkgId },
      data: { status: "approved", sentAt: null, sendStartedAt: new Date() },
    });
    const { buffer } = await buildBackupZip(mine.userId, "notmine-a@example.com");
    await importBackup(buffer, mine.userId, "notmine-a@example.com", true);
    const otherPkg = await prisma.applicationPackage.findUniqueOrThrow({ where: { id: other.pkgId } });
    expect(otherPkg.sendStartedAt).not.toBeNull();
  }, 30_000);

  // Backups written before this PR carry resume entries named after the
  // previous import, "<uuid>-name.pdf". They still restore, under bounded
  // names, with the right bytes and display names.
  it("restores pre-fix resume entries, duplicate and unusual names, docx and unsniffable bytes", async () => {
    const userId = await seedAccount(prisma, "oldnames@example.com");
    const profile = await prisma.profile.create({ data: { userId } });
    const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("synthetic docx")]);
    const pdfA = Buffer.from("%PDF-1.4\n% A\n%%EOF\n");
    const pdfB = Buffer.from("%PDF-1.4\n% B\n%%EOF\n");
    const pdfC = Buffer.from("%PDF-1.4\n% C\n%%EOF\n");
    const seeded = [
      await seedResume(userId, profile.id, `${randomUUID()}-${randomUUID()}-My CV.pdf`, "My CV.pdf", pdfA),
      await seedResume(userId, profile.id, `${randomUUID()}-My CV.pdf`, "My CV.pdf", pdfB),
      await seedResume(userId, profile.id, `${randomUUID()}-Résumé v1.2 final..pdf`, "Résumé v1.2 final..pdf", pdfC),
      await seedResume(userId, profile.id, `${randomUUID()}-cv.docx`, "cv.docx", DOCX),
      await seedResume(userId, profile.id, `${randomUUID()}-notes.pdf`, "notes.pdf", Buffer.from("plain text")),
    ];
    const { buffer } = await buildBackupZip(userId, "oldnames@example.com");

    const dst = await seedAccount(prisma, "oldnamesdst@example.com");
    const result = await importBackup(buffer, dst, "oldnamesdst@example.com", false);
    expect(result.filesWritten).toBe(4);

    const files = await prisma.file.findMany({ where: { Resume: { profile: { userId: dst } } } });
    expect(files).toHaveLength(5);
    const byName = (n: string) => files.filter((f) => f.fileName === n);
    for (const f of files) {
      expect(path.dirname(f.filePath)).toBe(resumesDir());
      expect(path.basename(f.filePath)).toMatch(new RegExp(`^${f.id}\\.(pdf|docx)$`));
    }
    // Two resumes with one display name keep distinct paths and their own bytes.
    const twins = byName("My CV.pdf");
    expect(twins).toHaveLength(2);
    expect(twins[0].filePath).not.toBe(twins[1].filePath);
    expect(twins.map((f) => fs.readFileSync(f.filePath).toString()).sort()).toEqual(
      [pdfA.toString(), pdfB.toString()].sort(),
    );
    const accent = byName("Résumé v1.2 final..pdf")[0];
    expect(fs.readFileSync(accent.filePath)).toEqual(pdfC);
    const docx = byName("cv.docx")[0];
    expect(path.extname(docx.filePath)).toBe(".docx");
    expect(docx.fileType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(fs.readFileSync(docx.filePath)).toEqual(DOCX);
    // Unsniffable bytes are dropped, the row stays, nothing lands on disk.
    const rejected = byName("notes.pdf")[0];
    expect(path.basename(rejected.filePath)).toBe(`${rejected.id}.pdf`);
    expect(fs.existsSync(rejected.filePath)).toBe(false);
    // The source account's files are untouched.
    for (const s of seeded) expect(fs.existsSync(s.filePath)).toBe(true);
  }, 30_000);

  // A transaction failure after resume (not cockpit) bytes were written: the
  // new resume files are removed, the old rows and bytes are intact.
  it("a failed transaction removes newly written resume files and keeps the old ones", async () => {
    const a = await seedCockpit("resfail@example.com");
    const profile = await prisma.profile.create({ data: { userId: a.userId } });
    const old = await seedResume(a.userId, profile.id, `${randomUUID()}-Old.pdf`, "Old.pdf", PDF);
    const { buffer } = await buildBackupZip(a.userId, "resfail@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    data.ApplicationPackage.push({ ...data.ApplicationPackage[0], id: randomUUID(), idempotencyKey: null });
    zip.file("data.json", JSON.stringify(data));
    const broken = await zip.generateAsync({ type: "nodebuffer" });
    const before = fs.readdirSync(resumesDir()).sort();

    await expect(importBackup(broken, a.userId, "resfail@example.com", true)).rejects.toThrow(
      /nothing was changed/i,
    );

    expect(fs.readdirSync(resumesDir()).sort()).toEqual(before);
    expect(fs.readFileSync(old.filePath)).toEqual(PDF);
    expect(await prisma.file.findUnique({ where: { id: old.fileId } })).not.toBeNull();
    expect(await prisma.resume.count({ where: { profile: { userId: a.userId } } })).toBe(1);
  }, 30_000);

  // After commit, removing a replaced file can fail. The import has already
  // succeeded, so it reports success; the new data is complete.
  it("reports success when an old file cannot be removed after commit", async () => {
    const a = await seedCockpit("unlinkfail@example.com");
    const { buffer } = await buildBackupZip(a.userId, "unlinkfail@example.com");
    const realUnlink = fsp.unlink;
    const spy = vi.spyOn(fsp, "unlink").mockImplementation((async (p: unknown) => {
      if (String(p) === a.filePath) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return (realUnlink as (p: unknown) => Promise<void>)(p);
    }) as typeof fsp.unlink);
    let result;
    try {
      result = await importBackup(buffer, a.userId, "unlinkfail@example.com", true);
    } finally {
      spy.mockRestore();
    }
    expect(result.counts.ApplicationPackage).toBe(1);
    const pkg = await prisma.applicationPackage.findFirstOrThrow({
      where: { userId: a.userId },
      include: { cvFile: true },
    });
    expect(fs.readFileSync(pkg.cvFile!.filePath)).toEqual(PDF);
    // The old bytes are left behind (logged), not a data loss.
    expect(fs.existsSync(a.filePath)).toBe(true);
  }, 30_000);

  it("never writes the Gmail token into the pre-import snapshot", async () => {
    const a = await seedCockpit("snapsecret@example.com");
    const { buffer } = await buildBackupZip(a.userId, "snapsecret@example.com");
    const result = await importBackup(buffer, a.userId, "snapsecret@example.com", true);
    const snap = await JSZip.loadAsync(fs.readFileSync(result.snapshotPath!));
    for (const name of Object.keys(snap.files)) {
      if (snap.files[name].dir) continue;
      const text = (await snap.file(name)!.async("nodebuffer")).toString("latin1");
      expect(text, name).not.toContain(SECRET_TOKEN);
      expect(text, name).not.toContain(SECRET_IV);
    }
    expect(await prisma.gmailAccount.count({ where: { userId: a.userId } })).toBe(1);
  }, 30_000);

  it("preflight accepts a backup written before cockpit data existed", async () => {
    const src = await seedCockpit("oldpre@example.com");
    const { buffer } = await buildBackupZip(src.userId, "oldpre@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    delete data.ApplicationPackage;
    delete data.SentEmail;
    zip.file("data.json", JSON.stringify(data));
    const old = await zip.generateAsync({ type: "nodebuffer" });
    const dst = await seedAccount(prisma, "oldpredst@example.com");
    const result = await preflightBackup(old, dst, "oldpredst@example.com");
    expect(result.targetIsEmpty).toBe(true);
    expect(result.targetCounts).toMatchObject({ ApplicationPackage: 0, SentEmail: 0, File: 0 });
  }, 30_000);
});

// Issue #60, review follow-ups on PR #69.
describe("backup import review follow-ups (issue #60)", () => {
  const resumesDir = () => path.join(uploadsDir, "files", "resumes");

  async function seedTwoResumes(email: string) {
    const userId = await seedAccount(prisma, email);
    const profile = await prisma.profile.create({ data: { userId } });
    for (const name of ["one.pdf", "two.pdf"]) {
      const p = path.join(resumesDir(), `${randomUUID()}-${name}`);
      fs.writeFileSync(p, PDF);
      const f = await prisma.file.create({
        data: { fileName: name, filePath: p, fileType: "application/pdf" },
      });
      await prisma.resume.create({ data: { profileId: profile.id, title: name, FileId: f.id } });
    }
    const { buffer } = await buildBackupZip(userId, email);
    return { userId, buffer };
  }

  // S1 + N3: a write that fails part-way (disk full) leaves a truncated file;
  // it is removed, and the user is told the disk is full.
  it("removes a part-written file when the disk fills up, and says so", async () => {
    const { userId, buffer } = await seedTwoResumes("partial@example.com");
    const before = fs.readdirSync(resumesDir()).sort();

    const realWrite = fsp.writeFile;
    const spy = vi.spyOn(fsp, "writeFile").mockImplementation((async (...args: unknown[]) => {
      const target = String(args[0]);
      if (target.startsWith(resumesDir() + path.sep)) {
        fs.writeFileSync(target, Buffer.from("%PDF-"));
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return (realWrite as (...a: unknown[]) => Promise<void>)(...args);
    }) as typeof fsp.writeFile);
    try {
      await expect(
        importBackup(buffer, userId, "partial@example.com", true),
      ).rejects.toThrow(/disk is full.*nothing was changed/i);
    } finally {
      spy.mockRestore();
    }

    expect(fs.readdirSync(resumesDir()).sort()).toEqual(before);
  }, 30_000);

  // S1 (wx): a file already at the target path is not overwritten, and the
  // failed import does not delete it either: it is not the import's file.
  it("never overwrites or deletes a file already at a target path", async () => {
    const { userId, buffer } = await seedTwoResumes("collide@example.com");
    const foreign = Buffer.from("%PDF-1.4 someone else\n");
    let planted: string | null = null;

    const realWrite = fsp.writeFile;
    const spy = vi.spyOn(fsp, "writeFile").mockImplementation((async (...args: unknown[]) => {
      const target = String(args[0]);
      if (planted === null && target.startsWith(resumesDir() + path.sep)) {
        planted = target;
        fs.writeFileSync(target, foreign);
      }
      return (realWrite as (...a: unknown[]) => Promise<void>)(...args);
    }) as typeof fsp.writeFile);
    try {
      await expect(
        importBackup(buffer, userId, "collide@example.com", true),
      ).rejects.toThrow(/nothing was changed/i);
    } finally {
      spy.mockRestore();
    }

    expect(planted).not.toBeNull();
    expect(fs.readFileSync(planted!)).toEqual(foreign);
    fs.unlinkSync(planted!);
  }, 30_000);

  // N2: the refusal names the locked application and covers rollback too.
  it("names the locked application in the refusal", async () => {
    const a = await seedCockpit("named@example.com");
    const { buffer } = await buildBackupZip(a.userId, "named@example.com");
    await prisma.applicationPackage.update({
      where: { id: a.pkgId },
      data: { status: "approved", sentAt: null, sendStartedAt: new Date() },
    });
    const error = await importBackup(buffer, a.userId, "named@example.com", true).catch(
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`"Engineer at Acme" (package ${a.pkgId})`);
    expect(message).toMatch(/import or rollback/);
  }, 30_000);
});
