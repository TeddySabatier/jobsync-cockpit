// @vitest-environment node
import fs from "fs";
import path from "path";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createCockpitTestDb, type CockpitTestDb } from "./helpers/sqlite";

const MIGRATION = path.join(
  __dirname,
  "../../prisma/migrations/20261104120000_cockpit_v0/migration.sql",
);

let db: CockpitTestDb;
let prisma: PrismaClient;
let userId: string;
let jobId: string;

async function seedJob(p: PrismaClient, email: string) {
  const user = await p.user.create({
    data: { name: "Jane Doe", email, password: "x" },
  });
  const status = await p.jobStatus.upsert({
    where: { value: "draft" },
    update: {},
    create: { label: "Draft", value: "draft" },
  });
  const title = await p.jobTitle.create({
    data: { label: "Engineer", value: "engineer", createdBy: user.id },
  });
  const company = await p.company.create({
    data: { label: "Example Corp", value: "example-corp", createdBy: user.id },
  });
  const job = await p.job.create({
    data: {
      userId: user.id,
      description: "A synthetic job",
      jobType: "FT",
      createdAt: new Date(),
      statusId: status.id,
      jobTitleId: title.id,
      companyId: company.id,
    },
  });
  return { userId: user.id, jobId: job.id };
}

const pkgData = (over: Record<string, unknown> = {}) => ({
  userId,
  jobId,
  version: 1,
  emailSubject: "Application",
  emailBody: "Hello",
  ...over,
});

beforeAll(async () => {
  db = createCockpitTestDb();
  prisma = db.prisma;
  ({ userId, jobId } = await seedJob(prisma, "jane@example.com"));
}, 120_000);

afterAll(async () => {
  await db.cleanup();
});

describe("migration 20261104120000_cockpit_v0", () => {
  it("is pure DDL with a comment header (AC-01)", () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    expect(sql.startsWith("--")).toBe(true);
    const statements = sql
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("--"))
      .filter((l) => /^[A-Z]+\s/.test(l));
    expect(statements.length).toBeGreaterThan(0);
    for (const line of statements) {
      expect(line).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) /);
    }
    expect(sql).toContain(
      'CREATE INDEX "ApplicationPackage_userId_status_createdAt_idx" ON "ApplicationPackage"("userId", "status", "createdAt")',
    );
  });

  it("applies on an empty DB and a synthetic job survives", async () => {
    expect(await prisma.job.count({ where: { id: jobId } })).toBe(1);
    expect(await prisma.applicationPackage.count()).toBe(0);
    expect(await prisma.gmailAccount.count()).toBe(0);
    expect(await prisma.sentEmail.count()).toBe(0);
  });

  it("creates a package with the spec defaults", async () => {
    const p = await prisma.applicationPackage.create({ data: pkgData() });
    expect(p.status).toBe("pending");
    expect(p.cvPdfStale).toBe(false);
    expect(p.sendStartedAt).toBeNull();
    expect(p.sendOutcome).toBeNull();
    expect(p.updatedAt).toBeInstanceOf(Date);
  });

  it("rejects a duplicate (jobId, version)", async () => {
    await expect(
      prisma.applicationPackage.create({ data: pkgData() }),
    ).rejects.toMatchObject({ code: "P2002" });
    const ok = await prisma.applicationPackage.create({
      data: pkgData({ version: 2 }),
    });
    expect(ok.version).toBe(2);
  });

  it("rejects a duplicate (userId, idempotencyKey) but allows many NULL keys", async () => {
    await prisma.applicationPackage.create({
      data: pkgData({ version: 3, idempotencyKey: "key-1" }),
    });
    const err = await prisma.applicationPackage
      .create({ data: pkgData({ version: 4, idempotencyKey: "key-1" }) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target).toEqual(
      expect.arrayContaining(["userId", "idempotencyKey"]),
    );
    // versions 1 and 2 above already have a NULL key
    expect(
      await prisma.applicationPackage.count({
        where: { idempotencyKey: null },
      }),
    ).toBe(2);
  });

  it("accepts a GmailAccount (one per user) and a SentEmail (one per package)", async () => {
    await prisma.gmailAccount.create({
      data: {
        userId,
        email: "jane@example.com",
        encryptedRefreshToken: "enc",
        iv: "iv",
        scopes: "https://www.googleapis.com/auth/gmail.send",
      },
    });
    await expect(
      prisma.gmailAccount.create({
        data: {
          userId,
          email: "jane@example.com",
          encryptedRefreshToken: "enc2",
          iv: "iv2",
          scopes: "x",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const pkg = await prisma.applicationPackage.findFirstOrThrow({
      where: { jobId, version: 1 },
    });
    const sent = {
      userId,
      packageId: pkg.id,
      fromAddress: "jane@example.com",
      toAddress: "hr@example.com",
      gmailMessageId: "m1",
      threadId: "t1",
    };
    await prisma.sentEmail.create({ data: sent });
    await expect(prisma.sentEmail.create({ data: sent })).rejects.toMatchObject(
      {
        code: "P2002",
      },
    );
  });

  it("sets cvFileId to NULL when the File is deleted", async () => {
    const file = await prisma.file.create({
      data: {
        fileName: "cv.pdf",
        filePath: "x/cv.pdf",
        fileType: "application/pdf",
      },
    });
    const p = await prisma.applicationPackage.create({
      data: pkgData({ version: 10, cvFileId: file.id }),
    });
    await prisma.file.delete({ where: { id: file.id } });
    const after = await prisma.applicationPackage.findUniqueOrThrow({
      where: { id: p.id },
    });
    expect(after.cvFileId).toBeNull();
  });

  it("cascades Job delete to its packages and their SentEmail", async () => {
    expect(
      await prisma.applicationPackage.count({ where: { jobId } }),
    ).toBeGreaterThan(0);
    expect(await prisma.sentEmail.count()).toBe(1);
    await prisma.job.delete({ where: { id: jobId } });
    expect(await prisma.applicationPackage.count({ where: { jobId } })).toBe(0);
    expect(await prisma.sentEmail.count()).toBe(0);
    // the user and the Gmail connection are not affected by a job delete
    expect(await prisma.gmailAccount.count({ where: { userId } })).toBe(1);
  });

  it("cascades User delete to its GmailAccount, packages and SentEmail", async () => {
    // A bare user (no upstream rows, which restrict a user delete) owning
    // cockpit rows that point at another user's job.
    const owner = await seedJob(prisma, "jane2@example.com");
    const bare = await prisma.user.create({
      data: { name: "John Doe", email: "john@example.com", password: "x" },
    });
    const pkg = await prisma.applicationPackage.create({
      data: {
        userId: bare.id,
        jobId: owner.jobId,
        version: 1,
        emailSubject: "s",
        emailBody: "b",
      },
    });
    await prisma.sentEmail.create({
      data: {
        userId: bare.id,
        packageId: pkg.id,
        fromAddress: "a@example.com",
        toAddress: "b@example.com",
        gmailMessageId: "m",
        threadId: "t",
      },
    });
    await prisma.gmailAccount.create({
      data: {
        userId: bare.id,
        email: "a@example.com",
        encryptedRefreshToken: "e",
        iv: "i",
        scopes: "s",
      },
    });

    await prisma.user.delete({ where: { id: bare.id } });

    expect(
      await prisma.applicationPackage.count({ where: { userId: bare.id } }),
    ).toBe(0);
    expect(await prisma.sentEmail.count({ where: { userId: bare.id } })).toBe(
      0,
    );
    expect(
      await prisma.gmailAccount.count({ where: { userId: bare.id } }),
    ).toBe(0);
    expect(await prisma.job.count({ where: { id: owner.jobId } })).toBe(1);
  });
});
