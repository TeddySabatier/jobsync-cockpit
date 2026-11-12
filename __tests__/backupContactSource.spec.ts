// @vitest-environment node
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { seedAccount } from "./helpers/backupTestDb";

// D-041: ApplicationPackage.contactSource travels in backups; backups made
// before it (format 1 and 2 files without the key) still import, as null.
// Real SQLite, synthetic data only.

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

async function seed(email: string) {
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
  await prisma.applicationPackage.create({
    data: {
      userId,
      jobId: job.id,
      version: 1,
      status: "pending",
      emailTo: "hr@acme.example",
      emailSubject: "Application",
      emailBody: "Body",
      contactSource: "https://acme.example/careers",
    },
  });
  return userId;
}

type Json = Record<string, any>;
const dataOf = async (zip: JSZip) =>
  JSON.parse(await zip.file("data.json")!.async("string")) as Json;
const manifestOf = async (zip: JSZip) =>
  JSON.parse(await zip.file("manifest.json")!.async("string")) as Json;
async function rezip(zip: JSZip, data: Json, formatVersion?: number) {
  zip.file("data.json", JSON.stringify(data));
  if (formatVersion !== undefined) {
    const m = await manifestOf(zip);
    zip.file("manifest.json", JSON.stringify({ ...m, formatVersion }));
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("backup: contactSource (D-041)", () => {
  it("round trip keeps it", async () => {
    const src = await seed("cs-src@example.com");
    const { buffer } = await buildBackupZip(src, "cs-src@example.com");
    const data = await dataOf(await JSZip.loadAsync(buffer));
    expect(data.ApplicationPackage[0].contactSource).toBe("https://acme.example/careers");
    const dst = await seedAccount(prisma, "cs-dst@example.com");
    await importBackup(buffer, dst, "cs-dst@example.com", false);
    const p = await prisma.applicationPackage.findFirstOrThrow({ where: { userId: dst } });
    expect(p.contactSource).toBe("https://acme.example/careers");
  });

  it.each([1, 2])("a format %i file without the key imports with contactSource null", async (v) => {
    const src = await seed(`cs-v${v}@example.com`);
    const { buffer } = await buildBackupZip(src, `cs-v${v}@example.com`);
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    data.ApplicationPackage = data.ApplicationPackage.map(
      ({ contactSource: _c, ...rest }: Json) =>
        v === 1 ? (({ kind: _k, replyToPackageId: _r, ...r }: Json) => r)(rest) : rest,
    );
    if (v === 1) {
      delete data.JobFollowUp;
      data.SentEmail = data.SentEmail.map(({ messageIdHeader: _m, ...r }: Json) => r);
    }
    const dst = await seedAccount(prisma, `cs-v${v}dst@example.com`);
    await importBackup(await rezip(zip, data, v), dst, `cs-v${v}dst@example.com`, false);
    const p = await prisma.applicationPackage.findFirstOrThrow({ where: { userId: dst } });
    expect(p.contactSource).toBeNull();
    expect(p.emailTo).toBe("hr@acme.example");
  });

  it("a non-string contactSource is refused and nothing is imported", async () => {
    const src = await seed("cs-bad@example.com");
    const { buffer } = await buildBackupZip(src, "cs-bad@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = await dataOf(zip);
    data.ApplicationPackage[0].contactSource = { evil: true };
    const dst = await seedAccount(prisma, "cs-baddst@example.com");
    await expect(importBackup(await rezip(zip, data), dst, "x@example.com", false)).rejects.toThrow();
    expect(await prisma.applicationPackage.count({ where: { userId: dst } })).toBe(0);
  });
});
