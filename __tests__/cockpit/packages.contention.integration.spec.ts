// @vitest-environment node
import { PrismaClient } from "@prisma/client";

// Real SQLite write contention on submit (review 01 #3, D-018 (d)), with no
// mocked Prisma error: a second connection holds the database write lock, so
// the submit's own write waits for SQLite and gives up. The service client
// waits 1 s (socket_timeout) instead of the default 5 s to keep the test short.
const db = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("./helpers/sqlite");
  const { PrismaClient: Client } = await import("@prisma/client");
  const harness = createCockpitTestDb();
  const service = new Client({
    datasources: { db: { url: `${harness.url}?socket_timeout=1` } },
  });
  return { ...harness, service };
});

vi.mock("@/lib/db", () => ({ default: db.service }));

import { submitPackage } from "@/lib/cockpit/packages";

const prisma = db.prisma;
let userId: string;
let draftId: string;
let titleId: string;
let companyId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { name: "Jane Doe", email: "jane@example.com", password: "x" },
  });
  userId = user.id;
  titleId = (
    await prisma.jobTitle.create({
      data: { label: "Engineer", value: "eng", createdBy: userId },
    })
  ).id;
  companyId = (
    await prisma.company.create({
      data: { label: "Example Corp", value: "corp", createdBy: userId },
    })
  ).id;
  draftId = (
    await prisma.jobStatus.create({ data: { label: "Draft", value: "draft" } })
  ).id;
}, 120_000);

afterAll(async () => {
  await db.service.$disconnect();
  await db.cleanup();
});

const newJob = async () =>
  (
    await prisma.job.create({
      data: {
        userId,
        description: "A synthetic job",
        jobType: "FT",
        createdAt: new Date(),
        statusId: draftId,
        jobTitleId: titleId,
        companyId,
      },
    })
  ).id;

// Holds the SQLite write lock from another connection until release() is called.
async function holdWriteLock(jobId: string) {
  const other = new PrismaClient({ datasources: { db: { url: db.url } } });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const done = other
    .$transaction(
      async (tx) => {
        await tx.job.update({
          where: { id: jobId },
          data: { description: "held by another writer" },
        });
        locked();
        await gate;
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    .finally(() => other.$disconnect());
  await isLocked;
  return async () => {
    release();
    await done;
  };
}

it("a submit blocked by another writer (SQLite busy) is CONFLICT, not INTERNAL, and the replay succeeds (review 01 #3)", async () => {
  const jobId = await newJob();
  const input = {
    jobId,
    emailTo: "hr@example.com",
    emailSubject: "Application - Engineer",
    emailBody: "Hello, I am Jane Doe.",
    fitGrade: "A" as const,
    idempotencyKey: "busy-1",
  };
  const release = await holdWriteLock(jobId);
  let blocked: unknown;
  try {
    blocked = await submitPackage(userId, input).then(
      () => "resolved",
      (e: unknown) => e,
    );
  } finally {
    await release();
  }
  expect(blocked).toMatchObject({ code: "CONFLICT" });
  expect(await prisma.applicationPackage.count({ where: { jobId } })).toBe(0);

  // CONFLICT means "replay the whole submit": once the lock is gone it works.
  const replay = await submitPackage(userId, input);
  expect(replay).toMatchObject({ idempotent: false });
  expect(replay.package).toMatchObject({ version: 1, status: "pending" });
}, 60_000);
