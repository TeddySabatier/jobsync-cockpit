// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";

// D-042: the review side of follow-ups against a real (temp) database: the
// outcome toggles, the queue (follow-up drafts in To do, snoozed ones hidden),
// the due count and the summary the UI reads. Synthetic data only.

const db = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("./helpers/sqlite");
  return createCockpitTestDb();
});
const uploads = vi.hoisted(() => ({ dir: "" }));

vi.mock("@/lib/db", () => ({ default: db.prisma }));
vi.mock("@/lib/constants", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/constants")>();
  return {
    ...mod,
    APP_CONSTANTS: {
      ...mod.APP_CONSTANTS,
      get UPLOADS_DIR() {
        return uploads.dir;
      },
    },
  };
});

import {
  followUpStepOf,
  getFollowUpSummary,
  setApplicationOutcome,
  snoozeFollowUp,
} from "@/lib/cockpit/followUps";
import { countDueFollowUps, listDueFollowUps } from "@/lib/cockpit/followUpMcp";
import {
  countPackagesByTab,
  countTodo,
  listPackagesByTab,
  type PackageStatus,
} from "@/lib/cockpit/packages";
import { createJobFor, seedUserWithRefs, type SeededUser } from "./helpers/seedUser";

const prisma = db.prisma;
let userA: string;
let userB: string;
let appliedId: string;
let rejectedId: string;
let interviewId: string;
const refs: Record<string, SeededUser> = {};

// Monday 2026-03-02 10:00 UTC: step 1 is due Monday 2026-03-09.
const SENT = new Date("2026-03-02T10:00:00Z");
const DAY9 = new Date("2026-03-09T12:00:00Z");

async function mk(
  jobId: string,
  kind: "application" | "follow_up",
  version: number,
  status: PackageStatus,
  over: Record<string, unknown> = {},
  userId = userA,
) {
  return prisma.applicationPackage.create({
    data: {
      userId,
      jobId,
      kind,
      version,
      status,
      emailTo: "hr@example.com",
      emailSubject: kind === "application" ? "Application" : "Re: Application",
      emailBody: "Hello",
      ...(status === "sent" ? { sentAt: SENT, sentVia: "gmail" } : {}),
      ...over,
    },
  });
}

async function appliedJob(userId = userA) {
  const jobId = await createJobFor(prisma, refs[userId], appliedId);
  const app = await mk(jobId, "application", 1, "sent", {}, userId);
  await prisma.sentEmail.create({
    data: {
      userId,
      packageId: app.id,
      fromAddress: "you@example.com",
      toAddress: "hr@example.com",
      gmailMessageId: "m1",
      threadId: "18c0ffee",
      messageIdHeader: "<a@jobsync.local>",
      sentAt: SENT,
    },
  });
  return { jobId, app };
}

const statusOf = async (jobId: string) =>
  (await prisma.job.findUniqueOrThrow({ where: { id: jobId }, include: { Status: true } })).Status
    ?.value;
const row = (id: string) => prisma.applicationPackage.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  uploads.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-fur-"));
  for (const email of ["jane@example.com", "john@example.com"]) {
    const u = await seedUserWithRefs(prisma, email);
    refs[u.id] = u;
    if (!userA) userA = u.id;
    else userB = u.id;
  }
  await prisma.jobStatus.create({ data: { label: "Draft", value: "draft" } });
  appliedId = (await prisma.jobStatus.create({ data: { label: "Applied", value: "applied" } })).id;
  rejectedId = (await prisma.jobStatus.create({ data: { label: "Rejected", value: "rejected" } })).id;
  interviewId = (await prisma.jobStatus.create({ data: { label: "Interview", value: "interview" } })).id;
}, 120_000);
afterAll(async () => {
  fs.rmSync(uploads.dir, { recursive: true, force: true });
  await db.cleanup();
});

describe("setApplicationOutcome: the two toggles", () => {
  it("Got a reply: outcome set, open drafts superseded, job status untouched; pressed again clears it", async () => {
    const { jobId, app } = await appliedJob();
    const draft = await mk(jobId, "follow_up", 1, "pending", { replyToPackageId: app.id });
    const state = await setApplicationOutcome(userA, jobId, "replied", DAY9);
    expect(state).toMatchObject({ outcome: "replied" });
    expect((await row(draft.id)).status).toBe("superseded");
    expect(await statusOf(jobId)).toBe("applied");
    expect((await getFollowUpSummary(userA, jobId, DAY9))?.reason).toBe("outcome");

    const cleared = await setApplicationOutcome(userA, jobId, null, DAY9);
    expect(cleared).toMatchObject({ outcome: null, outcomeAt: null });
    expect(await statusOf(jobId)).toBe("applied");
    expect((await getFollowUpSummary(userA, jobId, DAY9))?.status).toBe("due");
  });

  it("Rejected / closed sets the job status; pressed again puts it back to applied", async () => {
    const { jobId } = await appliedJob();
    await setApplicationOutcome(userA, jobId, "rejected", DAY9);
    expect(await statusOf(jobId)).toBe("rejected");
    await setApplicationOutcome(userA, jobId, null, DAY9);
    expect(await statusOf(jobId)).toBe("applied");
  });

  it("switching from rejected to replied restores applied", async () => {
    const { jobId } = await appliedJob();
    await setApplicationOutcome(userA, jobId, "rejected", DAY9);
    await setApplicationOutcome(userA, jobId, "replied", DAY9);
    expect(await statusOf(jobId)).toBe("applied");
    expect((await prisma.jobFollowUp.findUniqueOrThrow({ where: { jobId } })).outcome).toBe("replied");
  });

  it("clearing rejected leaves a status the owner changed by hand", async () => {
    const { jobId } = await appliedJob();
    await setApplicationOutcome(userA, jobId, "rejected", DAY9);
    await prisma.job.update({ where: { id: jobId }, data: { statusId: interviewId } });
    await setApplicationOutcome(userA, jobId, null, DAY9);
    expect(await statusOf(jobId)).toBe("interview");
  });

  it("refuses other outcomes, another user's job and a job with no sent application", async () => {
    const { jobId } = await appliedJob();
    await expect(setApplicationOutcome(userA, jobId, "interview", DAY9)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(setApplicationOutcome(userB, jobId, "replied", DAY9)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const bare = await createJobFor(prisma, refs[userA], appliedId);
    await expect(setApplicationOutcome(userA, bare, "replied", DAY9)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect(await statusOf(jobId)).toBe("applied");
    void rejectedId;
  });
});

describe("the review queue lists follow-up drafts (kind all)", () => {
  it("a follow-up draft is a To do row; a snoozed one is hidden, also from the counts", async () => {
    const { jobId, app } = await appliedJob();
    const draft = await mk(jobId, "follow_up", 1, "pending", { replyToPackageId: app.id });
    const ids = async () => (await listPackagesByTab(userA, "todo", "all", DAY9)).map((r) => r.id);
    const before = await countTodo(userA, DAY9);
    const tabBefore = (await countPackagesByTab(userA, "all", DAY9)).todo;
    expect(await ids()).toContain(draft.id);
    expect((await listPackagesByTab(userA, "todo", "application", DAY9)).map((r) => r.id)).not.toContain(draft.id);

    await snoozeFollowUp(userA, jobId, 7, DAY9);
    expect(await ids()).not.toContain(draft.id);
    expect(await countTodo(userA, DAY9)).toBe(before - 1);
    expect((await countPackagesByTab(userA, "all", DAY9)).todo).toBe(tabBefore - 1);
    // Back when the snooze ends.
    const later = new Date(DAY9.getTime() + 8 * 24 * 3600 * 1000);
    expect((await listPackagesByTab(userA, "todo", "all", later)).map((r) => r.id)).toContain(draft.id);
  });

  // A JobFollowUp row with snoozedUntil null (a cleared outcome, or a skip of
  // step 1 before a step 2 draft) must not hide the draft: SQL `NULL > now` is
  // NULL and NOT(NULL) drops the row unless the filter excludes null first.
  it.each([
    ["a cleared outcome", "outcome"],
    ["a follow-up row with no snooze", "row"],
  ])("a draft stays in To do after %s (snoozedUntil null)", async (_n, how) => {
    const { jobId, app } = await appliedJob();
    if (how === "outcome") {
      await setApplicationOutcome(userA, jobId, "replied", DAY9);
      await setApplicationOutcome(userA, jobId, null, DAY9);
    } else {
      await prisma.jobFollowUp.create({ data: { userId: userA, jobId, skippedThrough: 0 } });
    }
    expect((await prisma.jobFollowUp.findUniqueOrThrow({ where: { jobId } })).snoozedUntil).toBeNull();
    const before = await countTodo(userA, DAY9);
    const tabBefore = (await countPackagesByTab(userA, "all", DAY9)).todo;
    const draft = await mk(jobId, "follow_up", 1, "pending", { replyToPackageId: app.id });
    expect((await listPackagesByTab(userA, "todo", "all", DAY9)).map((r) => r.id)).toContain(draft.id);
    expect(await countTodo(userA, DAY9)).toBe(before + 1);
    expect((await countPackagesByTab(userA, "all", DAY9)).todo).toBe(tabBefore + 1);
  });

  it("a locked follow-up draft stays visible while snoozed (its send must be resolved)", async () => {
    const { jobId, app } = await appliedJob();
    const draft = await mk(jobId, "follow_up", 1, "approved", {
      replyToPackageId: app.id,
      sendStartedAt: new Date(),
      sendOutcome: "unknown",
    });
    await prisma.jobFollowUp.create({
      data: { userId: userA, jobId, snoozedUntil: new Date(DAY9.getTime() + 86400000) },
    });
    expect((await listPackagesByTab(userA, "todo", "all", DAY9)).map((r) => r.id)).toContain(draft.id);
  });
});

describe("countDueFollowUps and the summary", () => {
  it("counts what listDueFollowUps lists (due, not drafted)", async () => {
    const fresh = await seedUserWithRefs(prisma, "due-count@example.com");
    refs[fresh.id] = fresh;
    const a = await appliedJob(fresh.id);
    await appliedJob(fresh.id);
    expect(await countDueFollowUps(fresh.id, DAY9)).toBe(2);
    await mk(a.jobId, "follow_up", 1, "pending", { replyToPackageId: a.app.id }, fresh.id);
    expect(await countDueFollowUps(fresh.id, DAY9)).toBe(1);
    expect((await listDueFollowUps(fresh.id, 100, DAY9)).length).toBe(1);
    expect(await countDueFollowUps(fresh.id, new Date("2026-03-05T12:00:00Z"))).toBe(0);
  });

  it("the summary carries the step, status, thread URL and application; a step per follow-up", async () => {
    const { jobId, app } = await appliedJob();
    const s = await getFollowUpSummary(userA, jobId, DAY9);
    expect(s).toMatchObject({
      jobId,
      step: 1,
      status: "due",
      outcome: null,
      stopped: false,
      threadUrl: "https://mail.google.com/mail/u/0/#all/18c0ffee",
      applicationPackageId: app.id,
    });
    expect(await getFollowUpSummary(userB, jobId, DAY9)).toBeNull();

    const sent1 = await mk(jobId, "follow_up", 1, "sent", {
      replyToPackageId: app.id,
      sentAt: new Date("2026-03-09T13:00:00Z"),
    });
    expect(await followUpStepOf(userA, { jobId, status: "sent", sentAt: sent1.sentAt }, null)).toBe(1);
    const s2 = await getFollowUpSummary(userA, jobId, new Date("2026-03-24T12:00:00Z"));
    expect(s2).toMatchObject({ step: 2, status: "due" });
    expect(await followUpStepOf(userA, { jobId, status: "pending", sentAt: null }, s2)).toBe(2);
  });

  it("no thread URL when the application has no SentEmail (marked sent by hand)", async () => {
    const jobId = await createJobFor(prisma, refs[userA], appliedId);
    await mk(jobId, "application", 1, "sent", { sentVia: "manual" });
    expect((await getFollowUpSummary(userA, jobId, DAY9))?.threadUrl).toBeNull();
  });
});
