// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { PrismaClient } from "@prisma/client";
import type { CockpitTestDb } from "./helpers/sqlite";
import { createJobFor, seedUserWithRefs, type SeededUser } from "./helpers/seedUser";

// Issue #75 / D-026: a job with packages is archived, never deleted, and the
// schema refuses the delete even if a code path forgets to check. Real SQLite,
// real migrations, synthetic data only.

const state = vi.hoisted(() => ({ userId: "" }));
// Migrated before the (hoisted) @/lib/db mock below builds its client.
const created = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("./helpers/sqlite");
  return createCockpitTestDb();
});

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(async () => ({ id: state.userId })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: created.url } } }),
  };
});

import {
  archiveJobById,
  deleteJobById,
  getJobsList,
} from "@/actions/job.actions";
import { clearDiscoveredJobs } from "@/actions/automation/discoveredJobs";

let db: CockpitTestDb;
let prisma: PrismaClient;
let me: SeededUser;
let other: SeededUser;
let draftId: string;

beforeAll(async () => {
  db = created;
  prisma = db.prisma;
  me = await seedUserWithRefs(prisma, "jane@example.com");
  other = await seedUserWithRefs(prisma, "john@example.com");
  const draft = await prisma.jobStatus.create({
    data: { label: "Draft", value: "draft" },
  });
  draftId = draft.id;
}, 120_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(() => {
  state.userId = me.id;
});

async function jobWithSentEmail(user: SeededUser = me): Promise<string> {
  const jobId = await createJobFor(prisma, user, draftId);
  const pkg = await prisma.applicationPackage.create({
    data: {
      userId: user.id,
      jobId,
      version: 1,
      status: "sent",
      emailSubject: "Application",
      emailBody: "Hello",
    },
  });
  await prisma.sentEmail.create({
    data: {
      userId: user.id,
      packageId: pkg.id,
      fromAddress: "a@example.com",
      toAddress: "b@example.com",
      gmailMessageId: "m",
      threadId: "t",
    },
  });
  return jobId;
}

const counts = async (jobId: string) => ({
  job: await prisma.job.count({ where: { id: jobId } }),
  packages: await prisma.applicationPackage.count({ where: { jobId } }),
  sent: await prisma.sentEmail.count({ where: { package: { jobId } } }),
});

describe("deleteJobById", () => {
  it("refuses a job with packages, points to Archive, keeps every row", async () => {
    const jobId = await jobWithSentEmail();
    const res = await deleteJobById(jobId);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/archive it instead/i);
    expect(await counts(jobId)).toEqual({ job: 1, packages: 1, sent: 1 });
  });

  it("still deletes a job that has no package", async () => {
    const jobId = await createJobFor(prisma, me, draftId);
    const res = await deleteJobById(jobId);
    expect(res.success).toBe(true);
    expect(await prisma.job.count({ where: { id: jobId } })).toBe(0);
  });

  it("does not delete another user's job", async () => {
    const jobId = await createJobFor(prisma, other, draftId);
    const res = await deleteJobById(jobId);
    expect(res.success).toBe(false);
    expect(await prisma.job.count({ where: { id: jobId } })).toBe(1);
  });
});

describe("schema: Job delete is restricted", () => {
  it("a raw job delete cannot cascade into packages or sent emails", async () => {
    const jobId = await jobWithSentEmail();
    await expect(
      prisma.job.delete({ where: { id: jobId } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.job.deleteMany({ where: { id: jobId } }),
    ).rejects.toMatchObject({ code: "P2003" });
    expect(await counts(jobId)).toEqual({ job: 1, packages: 1, sent: 1 });
  });
});

describe("archiveJobById", () => {
  it("sets status archived and leaves packages and sent emails alone", async () => {
    const jobId = await jobWithSentEmail();
    const res = await archiveJobById(jobId);
    expect(res.success).toBe(true);
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: { Status: true },
    });
    expect(job.Status.value).toBe("archived");
    expect(await counts(jobId)).toEqual({ job: 1, packages: 1, sent: 1 });
  });

  it("works for a job without packages and is idempotent", async () => {
    const jobId = await createJobFor(prisma, me, draftId);
    expect((await archiveJobById(jobId)).success).toBe(true);
    expect((await archiveJobById(jobId)).success).toBe(true);
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: { Status: true },
    });
    expect(job.Status.value).toBe("archived");
    expect(await prisma.jobStatus.count({ where: { value: "archived" } })).toBe(
      1,
    );
  });

  it("refuses another user's job", async () => {
    const jobId = await createJobFor(prisma, other, draftId);
    const res = await archiveJobById(jobId);
    expect(res.success).toBe(false);
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.statusId).toBe(draftId);
  });
});

describe("jobs list", () => {
  it("hides archived jobs by default and shows them under the archived filter, with their package count", async () => {
    const archived = await jobWithSentEmail();
    await archiveJobById(archived);
    const live = await createJobFor(prisma, me, draftId);

    const all = await getJobsList(1, 100);
    const ids = all.data.map((j: { id: string }) => j.id);
    expect(ids).toContain(live);
    expect(ids).not.toContain(archived);

    const onlyArchived = await getJobsList(1, 100, "archived");
    const row = onlyArchived.data.find((j: { id: string }) => j.id === archived);
    expect(row).toBeDefined();
    expect(row._count.applicationPackages).toBe(1);
    expect(
      onlyArchived.data.every(
        (j: { Status: { value: string } }) => j.Status.value === "archived",
      ),
    ).toBe(true);

    // facet filters that do not pick a status keep archived jobs out too
    const fullTime = await getJobsList(1, 100, "FT");
    expect(fullTime.data.map((j: { id: string }) => j.id)).not.toContain(
      archived,
    );
  });
});

describe("clearDiscoveredJobs", () => {
  it("keeps a dismissed discovered job that has a package", async () => {
    const profile = await prisma.profile.create({ data: { userId: me.id } });
    const resume = await prisma.resume.create({
      data: { profileId: profile.id, title: "CV" },
    });
    const automation = await prisma.automation.create({
      data: {
        userId: me.id,
        name: "auto",
        jobBoard: "greenhouse",
        keywords: "x",
        location: "y",
        resumeId: resume.id,
        scheduleHour: 8,
      },
    });
    const kept = await createJobFor(prisma, me, draftId, {
      automationId: automation.id,
      discoveryStatus: "dismissed",
    });
    await prisma.applicationPackage.create({
      data: {
        userId: me.id,
        jobId: kept,
        version: 1,
        emailSubject: "s",
        emailBody: "b",
      },
    });
    const gone = await createJobFor(prisma, me, draftId, {
      automationId: automation.id,
      discoveryStatus: "dismissed",
    });
    const res = await clearDiscoveredJobs({ automationId: automation.id });
    expect(res.success).toBe(true);
    expect(await prisma.job.count({ where: { id: kept } })).toBe(1);
    expect(await prisma.job.count({ where: { id: gone } })).toBe(0);
  });
});

describe("migration 20261112120000: upgrade keeps existing history", () => {
  it("copies packages and sent emails across the table redefinition", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobsync-mig75-"));
    const src = path.resolve(__dirname, "../../prisma");
    const prismaDir = path.join(root, "prisma");
    const NEW = "20261112120000_job_delete_restricts_packages";
    fs.cpSync(src, prismaDir, {
      recursive: true,
      filter: (p) => !p.includes(NEW),
    });
    const url = `file:${path.join(root, "t.db")}`;
    const schema = path.join(prismaDir, "schema.prisma");
    const env = { ...process.env, DATABASE_URL: url };
    const deploy = () =>
      execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", schema], {
        env,
        stdio: "pipe",
      });
    let client: PrismaClient | undefined;
    try {
      deploy();
      client = new PrismaClient({ datasources: { db: { url } } });
      const u = await seedUserWithRefs(client, "mig@example.com");
      const st = await client.jobStatus.create({
        data: { label: "Draft", value: "draft" },
      });
      const jobId = await createJobFor(client, u, st.id);
      await client.$executeRawUnsafe(
        `INSERT INTO "ApplicationPackage" ("id","userId","jobId","version","status","emailSubject","emailBody","cvPdfStale","createdAt","updatedAt") VALUES ('p1','${u.id}','${jobId}',1,'sent','s','b',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      );
      await client.$executeRawUnsafe(
        `INSERT INTO "SentEmail" ("id","userId","packageId","fromAddress","toAddress","gmailMessageId","threadId","sentAt") VALUES ('s1','${u.id}','p1','a@x.com','b@x.com','m','t',CURRENT_TIMESTAMP)`,
      );
      await client.$disconnect();

      fs.cpSync(
        path.join(src, "migrations", NEW),
        path.join(prismaDir, "migrations", NEW),
        { recursive: true },
      );
      deploy();

      client = new PrismaClient({ datasources: { db: { url } } });
      expect(await client.applicationPackage.count()).toBe(1);
      expect(await client.sentEmail.count()).toBe(1);
      const fks = await client.$queryRawUnsafe<{ on_delete: string }[]>(
        `SELECT "on_delete" FROM pragma_foreign_key_list('ApplicationPackage') WHERE "table" = 'Job'`,
      );
      expect(fks[0].on_delete).toBe("RESTRICT");
      await expect(
        client.job.delete({ where: { id: jobId } }),
      ).rejects.toMatchObject({ code: "P2003" });
      expect(await client.sentEmail.count()).toBe(1);
    } finally {
      await client?.$disconnect();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
