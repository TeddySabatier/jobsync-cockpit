// @vitest-environment node
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { cockpitUserDir } from "@/lib/cockpit/files";
import { log } from "@/lib/telemetry";
import { seedAccount } from "./helpers/backupTestDb";

// Issue #78 (D-024), same class as the download route: the backup export read
// every stored File.filePath and the import unlinked the old ones, both with
// no confinement. Real SQLite, real temp dirs and symlinks, synthetic data.

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
const PDF = Buffer.from("%PDF-1.4\n% synthetic resume\n%%EOF\n");
const SECRET = Buffer.from("%PDF-1.4 SECRET-OUTSIDE-UPLOADS\n%%EOF\n");

let uploads: string;
let resumes: string;

beforeAll(() => {
  uploads = path.join(fs.realpathSync(ctx.dir), "uploads");
  resumes = path.join(uploads, "files", "resumes");
  fs.mkdirSync(resumes, { recursive: true });
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploads;
}, 120_000);

afterAll(async () => {
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await prisma.$disconnect();
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

afterEach(() => vi.restoreAllMocks());

const write = (p: string, body: Buffer = PDF) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};
const outsidePath = () => path.join(ctx.dir, `outside-${randomUUID()}.pdf`);

async function account() {
  const email = `${randomUUID()}@example.com`;
  return { userId: await seedAccount(prisma, email), email };
}

// A resume of `userId` whose File row stores `filePath` as is.
async function resumeFile(userId: string, filePath: string): Promise<string> {
  const profile =
    (await prisma.profile.findFirst({ where: { userId } })) ??
    (await prisma.profile.create({ data: { userId } }));
  const file = await prisma.file.create({
    data: { fileName: "cv.pdf", filePath, fileType: "application/pdf" },
  });
  await prisma.resume.create({
    data: { profileId: profile.id, title: `CV ${randomUUID()}`, FileId: file.id },
  });
  return file.id;
}

// A cockpit package CV of `userId` whose File row stores `filePath` as is.
async function cockpitFile(userId: string, filePath: string): Promise<string> {
  const company = await prisma.company.create({
    data: { label: "Acme", value: `acme-${randomUUID()}`, createdBy: userId },
  });
  const title = await prisma.jobTitle.create({
    data: { label: "Engineer", value: `eng-${randomUUID()}`, createdBy: userId },
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
  const file = await prisma.file.create({
    data: { fileName: "Jane_Doe_CV.pdf", filePath, fileType: "application/pdf" },
  });
  await prisma.applicationPackage.create({
    data: {
      userId,
      jobId: job.id,
      version: 1,
      emailSubject: "Application",
      emailBody: "Body",
      cvFileId: file.id,
    },
  });
  return file.id;
}

async function exportOf(userId: string) {
  const { buffer } = await buildBackupZip(userId, "x@example.com");
  const zip = await JSZip.loadAsync(buffer);
  const data = JSON.parse(await zip.file("data.json")!.async("string"));
  const entries: Record<string, Buffer> = {};
  for (const name of Object.keys(zip.files)) {
    if (name.startsWith("files/") && !zip.files[name].dir) {
      entries[name] = await zip.files[name].async("nodebuffer");
    }
  }
  const missing = (id: string) =>
    data.File.find((f: { id: string }) => f.id === id).fileMissing === true;
  const has = (id: string) => Object.keys(entries).some((n) => n.startsWith(`files/${id}/`));
  return { buffer, entries, missing, has };
}

const noSecretIn = (entries: Record<string, Buffer>) =>
  Object.values(entries).every((b) => !b.includes("SECRET-OUTSIDE-UPLOADS"));

describe("backup export reads stored files only from their folder", () => {
  it("exports the user's resume file and cockpit CV (normal case)", async () => {
    const { userId } = await account();
    const r = await resumeFile(userId, write(path.join(resumes, `${randomUUID()}.pdf`)));
    const c = await cockpitFile(userId, write(path.join(cockpitUserDir(userId), `${randomUUID()}.pdf`)));
    const out = await exportOf(userId);
    expect(out.has(r) && out.has(c)).toBe(true);
    expect(out.missing(r) || out.missing(c)).toBe(false);
  });

  it("skips a legacy row outside the uploads dir: never read, code-only warning", async () => {
    const { userId } = await account();
    const outside = write(outsidePath(), SECRET);
    const id = await resumeFile(userId, outside);
    const warn = vi.spyOn(log, "warn");
    const out = await exportOf(userId);
    expect(out.has(id)).toBe(false);
    expect(out.missing(id)).toBe(true);
    expect(noSecretIn(out.entries)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.any(String), { code: "FILE_OUTSIDE_UPLOADS" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(outside);
  });

  it("skips a resume file that is a symlink pointing out", async () => {
    const { userId } = await account();
    const link = path.join(resumes, `${randomUUID()}.pdf`);
    fs.symlinkSync(write(outsidePath(), SECRET), link);
    const id = await resumeFile(userId, link);
    const out = await exportOf(userId);
    expect(out.missing(id)).toBe(true);
    expect(noSecretIn(out.entries)).toBe(true);
  });

  it("skips '..' out of the resumes dir", async () => {
    const { userId } = await account();
    const name = `dotdot-${randomUUID()}.pdf`;
    write(path.join(ctx.dir, name), SECRET);
    const id = await resumeFile(userId, `${resumes}/../../../${name}`);
    const out = await exportOf(userId);
    expect(out.missing(id)).toBe(true);
    expect(noSecretIn(out.entries)).toBe(true);
  });

  it("skips a cockpit CV stored outside the user's cockpit dir (resumes dir, another user's dir)", async () => {
    const { userId } = await account();
    const other = await account();
    const inResumes = await cockpitFile(userId, write(path.join(resumes, `${randomUUID()}.pdf`), SECRET));
    const inOther = await cockpitFile(
      userId,
      write(path.join(cockpitUserDir(other.userId), `${randomUUID()}.pdf`), SECRET),
    );
    const out = await exportOf(userId);
    expect(out.missing(inResumes) && out.missing(inOther)).toBe(true);
    expect(noSecretIn(out.entries)).toBe(true);
  });

  it("never carries another user's file", async () => {
    const { userId } = await account();
    const other = await account();
    const theirs = await resumeFile(other.userId, write(path.join(resumes, `${randomUUID()}.pdf`), SECRET));
    const out = await exportOf(userId);
    expect(out.has(theirs)).toBe(false);
    expect(noSecretIn(out.entries)).toBe(true);
  });
});

describe("backup import removes replaced files only from their folder", () => {
  it("removes the user's old resume file and old CV after the restore (normal case)", async () => {
    const { userId, email } = await account();
    const oldResume = write(path.join(resumes, `${randomUUID()}.pdf`));
    const oldCv = write(path.join(cockpitUserDir(userId), `${randomUUID()}.pdf`));
    await resumeFile(userId, oldResume);
    await cockpitFile(userId, oldCv);
    const { buffer } = await exportOf(userId);
    await importBackup(buffer, userId, email, true);
    expect(fs.existsSync(oldResume)).toBe(false);
    expect(fs.existsSync(oldCv)).toBe(false);
  });

  it("keeps a legacy row's file outside the uploads dir, code-only warning", async () => {
    const { userId, email } = await account();
    const outside = write(outsidePath(), SECRET);
    await resumeFile(userId, outside);
    const { buffer } = await exportOf(userId);
    const warn = vi.spyOn(log, "warn");
    await importBackup(buffer, userId, email, true);
    expect(fs.readFileSync(outside)).toEqual(SECRET);
    expect(warn).toHaveBeenCalledWith(expect.any(String), { code: "FILE_OUTSIDE_UPLOADS" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(outside);
  });

  it("keeps the target of a symlink in the resumes dir (and the link)", async () => {
    const { userId, email } = await account();
    const target = write(outsidePath(), SECRET);
    const link = path.join(resumes, `${randomUUID()}.pdf`);
    fs.symlinkSync(target, link);
    await resumeFile(userId, link);
    const { buffer } = await exportOf(userId);
    await importBackup(buffer, userId, email, true);
    expect(fs.readFileSync(target)).toEqual(SECRET);
  });

  it("keeps a replaced symlink inside the resumes dir and its in-dir target (another user's file)", async () => {
    const { userId, email } = await account();
    const other = await account();
    const theirs = write(path.join(resumes, `${randomUUID()}.pdf`), SECRET);
    await resumeFile(other.userId, theirs);
    const link = path.join(resumes, `${randomUUID()}.pdf`);
    fs.symlinkSync(theirs, link);
    await resumeFile(userId, link);
    const { buffer } = await exportOf(userId);
    const warn = vi.spyOn(log, "warn");
    await importBackup(buffer, userId, email, true);
    expect(fs.readFileSync(theirs)).toEqual(SECRET);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.any(String), { code: "FILE_OUTSIDE_UPLOADS" });
  });

  it("keeps an old CV row pointing into another user's cockpit dir", async () => {
    const { userId, email } = await account();
    const other = await account();
    const theirs = write(path.join(cockpitUserDir(other.userId), `${randomUUID()}.pdf`), SECRET);
    await cockpitFile(userId, theirs);
    const { buffer } = await exportOf(userId);
    await importBackup(buffer, userId, email, true);
    expect(fs.readFileSync(theirs)).toEqual(SECRET);
  });

  it("never touches another user's files", async () => {
    const { userId, email } = await account();
    const other = await account();
    const theirs = write(path.join(resumes, `${randomUUID()}.pdf`), SECRET);
    await resumeFile(other.userId, theirs);
    await resumeFile(userId, write(path.join(resumes, `${randomUUID()}.pdf`)));
    const { buffer } = await exportOf(userId);
    await importBackup(buffer, userId, email, true);
    expect(fs.readFileSync(theirs)).toEqual(SECRET);
  });
});
