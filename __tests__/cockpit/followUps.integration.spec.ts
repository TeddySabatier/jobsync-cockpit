// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";

// D-031: kind-aware package rules, the follow-up state actions, and the due
// calculation fed from a real (temp) database. Synthetic data only.

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

import { activeApplication } from "@/lib/cockpit/activePackage";
import {
  getFollowUpDue,
  getFollowUpState,
  setFollowUpOutcome,
  skipFollowUpStep,
  snoozeFollowUp,
  stopFollowUps,
  undoFollowUpOutcome,
} from "@/lib/cockpit/followUps";
import {
  listJobVersions,
  listPackagesByTab,
  rejectPackage,
  submitPackage,
  type PackageStatus,
} from "@/lib/cockpit/packages";
import { getFollowUpTimezone, getFollowUpWindowDays } from "@/lib/cockpit/config";
import type { SubmitApplicationPackageInput } from "@/lib/cockpit/schemas";
import { createJobFor, seedUserWithRefs, type SeededUser } from "./helpers/seedUser";

const prisma = db.prisma;

let userA: string;
let userB: string;
let draftId: string;
let appliedId: string;
let interviewId: string;
const refs: Record<string, SeededUser> = {};

async function seedUser(email: string) {
  const u = await seedUserWithRefs(prisma, email);
  refs[u.id] = u;
  return u.id;
}

const newJob = (userId: string, statusId = draftId) =>
  createJobFor(prisma, refs[userId], statusId);

const input = (
  jobId: string,
  over: Partial<SubmitApplicationPackageInput> = {},
): SubmitApplicationPackageInput => ({
  jobId,
  emailTo: "hr@example.com",
  emailSubject: "Application - Engineer",
  emailBody: "Hello",
  fitGrade: "A",
  ...over,
});

// A package straight in the DB.
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
      ...(status === "sent" ? { sentAt: new Date("2026-03-02T10:00:00Z"), sentVia: "gmail" } : {}),
      ...over,
    },
  });
}

const row = (id: string) => prisma.applicationPackage.findUniqueOrThrow({ where: { id } });

// An applied job with a sent application on Monday 2026-03-02 10:00 UTC:
// step 1 is due Monday 2026-03-09.
async function appliedJob(userId = userA) {
  const jobId = await newJob(userId, appliedId);
  const app = await mk(jobId, "application", 1, "sent", {}, userId);
  return { jobId, app };
}

const DAY9 = new Date("2026-03-09T12:00:00Z");

beforeAll(async () => {
  uploads.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-fu-"));
  userA = await seedUser("jane@example.com");
  userB = await seedUser("john@example.com");
  draftId = (await prisma.jobStatus.create({ data: { label: "Draft", value: "draft" } })).id;
  appliedId = (await prisma.jobStatus.create({ data: { label: "Applied", value: "applied" } })).id;
  interviewId = (await prisma.jobStatus.create({ data: { label: "Interview", value: "interview" } })).id;
}, 120_000);

afterAll(async () => {
  fs.rmSync(uploads.dir, { recursive: true, force: true });
  await db.cleanup();
});

describe("activeApplication: a follow-up is never the application", () => {
  it("ignores a follow-up even when it has a higher version and is not superseded", async () => {
    const { jobId, app } = await appliedJob();
    await mk(jobId, "follow_up", 1, "pending");
    await mk(jobId, "follow_up", 2, "approved");
    expect(await activeApplication(userA, jobId)).toEqual({ id: app.id, version: 1, status: "sent" });
  });

  it("is null when the job only has follow-ups, and skips superseded applications", async () => {
    const jobId = await newJob(userA);
    await mk(jobId, "follow_up", 1, "pending");
    expect(await activeApplication(userA, jobId)).toBeNull();
    const old = await mk(jobId, "application", 1, "superseded");
    expect(await activeApplication(userA, jobId)).toBeNull();
    const cur = await mk(jobId, "application", 2, "pending");
    expect(old.id).not.toBe(cur.id);
    expect((await activeApplication(userA, jobId))?.id).toBe(cur.id);
  });

  it("is scoped to the user", async () => {
    const { jobId } = await appliedJob();
    expect(await activeApplication(userB, jobId)).toBeNull();
  });
});

describe("read sites list applications only", () => {
  it("listPackagesByTab (queue tabs) never returns a follow-up draft; kind selects them", async () => {
    const jobId = await newJob(userA, appliedId);
    const app = await mk(jobId, "application", 1, "approved");
    const fu = await mk(jobId, "follow_up", 1, "pending");
    const todo = await listPackagesByTab(userA, "todo");
    expect(todo.map((r) => r.id)).toContain(app.id);
    expect(todo.map((r) => r.id)).not.toContain(fu.id);
    const fus = await listPackagesByTab(userA, "todo", "follow_up");
    expect(fus.map((r) => r.id)).toContain(fu.id);
    expect(fus.map((r) => r.id)).not.toContain(app.id);
  });

  it("listJobVersions lists one kind; versions are separate sequences", async () => {
    const { jobId, app } = await appliedJob();
    const f1 = await mk(jobId, "follow_up", 1, "sent");
    const f2 = await mk(jobId, "follow_up", 2, "pending");
    expect((await listJobVersions(userA, jobId)).map((v) => v.id)).toEqual([app.id]);
    expect((await listJobVersions(userA, jobId, "follow_up")).map((v) => v.id)).toEqual([f2.id, f1.id]);
  });
});

describe("submitPackage is per kind", () => {
  it("ALREADY_SENT stays an application rule: a sent application blocks applications", async () => {
    const { jobId } = await appliedJob();
    await expect(submitPackage(userA, input(jobId))).rejects.toMatchObject({ code: "ALREADY_SENT" });
  });

  it("a sent follow-up does not count as the application (no ALREADY_SENT for the first application)", async () => {
    const jobId = await newJob(userA);
    await mk(jobId, "follow_up", 1, "sent");
    const res = await submitPackage(userA, input(jobId));
    expect(res.package).toMatchObject({ kind: "application", version: 1, status: "pending" });
  });

  it("a rejected application blocks applications, not follow-ups", async () => {
    const jobId = await newJob(userA, appliedId);
    await mk(jobId, "application", 1, "rejected");
    await expect(submitPackage(userA, input(jobId))).rejects.toMatchObject({ code: "JOB_REJECTED" });
    const res = await submitPackage(userA, input(jobId), { kind: "follow_up" });
    expect(res.package.kind).toBe("follow_up");
  });

  it("versions are allocated per (job, kind) and a new follow-up supersedes only follow-up drafts", async () => {
    const { jobId, app } = await appliedJob();
    const f1 = await submitPackage(userA, input(jobId, { emailSubject: "Re: Application" }), {
      kind: "follow_up",
      replyToPackageId: app.id,
    });
    expect(f1.package).toMatchObject({ kind: "follow_up", version: 1, replyToPackageId: app.id, status: "pending" });
    const f2 = await submitPackage(userA, input(jobId, { emailSubject: "Re: Application" }), {
      kind: "follow_up",
      replyToPackageId: app.id,
    });
    expect(f2.package.version).toBe(2);
    expect(f2.supersededIds).toEqual([f1.package.id]);
    expect((await row(f1.package.id)).status).toBe("superseded");
    // The sent application is untouched, and still version 1 of its kind.
    expect(await row(app.id)).toMatchObject({ kind: "application", version: 1, status: "sent" });
  });

  it("an earlier sent follow-up does not block the next one (the cap is the due module's)", async () => {
    const { jobId, app } = await appliedJob();
    await mk(jobId, "follow_up", 1, "sent", { replyToPackageId: app.id });
    const res = await submitPackage(userA, input(jobId), { kind: "follow_up", replyToPackageId: app.id });
    expect(res.package).toMatchObject({ kind: "follow_up", version: 2 });
  });

  it("changes_requested follow-up drafts are superseded and marked handled by a resubmit", async () => {
    const { jobId } = await appliedJob();
    const draft = await mk(jobId, "follow_up", 1, "changes_requested", { changeRequest: "shorter" });
    const res = await submitPackage(userA, input(jobId), { kind: "follow_up" });
    expect(res.supersededIds).toEqual([draft.id]);
    expect(await row(draft.id)).toMatchObject({ status: "superseded" });
    expect((await row(draft.id)).changeRequestHandledAt).not.toBeNull();
  });

  it("an application submit supersedes application drafts only, never a follow-up draft", async () => {
    const jobId = await newJob(userA);
    const fu = await mk(jobId, "follow_up", 1, "pending");
    const a1 = await mk(jobId, "application", 1, "pending");
    const res = await submitPackage(userA, input(jobId));
    expect(res.package.version).toBe(2);
    expect(res.supersededIds).toEqual([a1.id]);
    expect((await row(fu.id)).status).toBe("pending");
  });

  it("a send lock on a follow-up blocks follow-up submits (CONFLICT) but not an application", async () => {
    const jobId = await newJob(userA);
    await mk(jobId, "follow_up", 1, "approved", { sendStartedAt: new Date() });
    await expect(submitPackage(userA, input(jobId), { kind: "follow_up" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const res = await submitPackage(userA, input(jobId));
    expect(res.package.kind).toBe("application");
  });

  it("an idempotency key replays within its kind and is a CONFLICT for the other kind", async () => {
    const { jobId } = await appliedJob();
    const key = "key-kind-1";
    const first = await submitPackage(userA, input(jobId, { idempotencyKey: key }), { kind: "follow_up" });
    const again = await submitPackage(userA, input(jobId, { idempotencyKey: key }), { kind: "follow_up" });
    expect(again).toMatchObject({ idempotent: true });
    expect(again.package.id).toBe(first.package.id);
    const otherJob = await newJob(userA);
    await expect(
      submitPackage(userA, input(jobId, { idempotencyKey: key })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      submitPackage(userA, input(otherJob, { idempotencyKey: key }), { kind: "follow_up" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("replyToPackageId is stored for follow-ups and dropped for applications", async () => {
    const jobId = await newJob(userA);
    const res = await submitPackage(userA, input(jobId), { replyToPackageId: "ignored" });
    expect(res.package.replyToPackageId).toBeNull();
  });
});

describe("getFollowUpDue from the database", () => {
  it("uses the sent application's sentAt and counts sent follow-up packages (recovery sends included)", async () => {
    const { jobId } = await appliedJob();
    let r = await getFollowUpDue(userA, jobId, DAY9);
    expect(r).toMatchObject({ eligible: true, step: 1, status: "due" });

    // Follow-up 1 sent through the recovery panel: sentVia "manual", no SentEmail.
    await mk(jobId, "follow_up", 1, "sent", { sentVia: "manual", sentAt: new Date("2026-03-10T10:00:00Z") });
    r = await getFollowUpDue(userA, jobId, new Date("2026-03-24T00:00:00Z"));
    expect(r).toMatchObject({ eligible: true, step: 2, status: "due" });
    expect(await prisma.sentEmail.count({ where: { userId: userA, packageId: { not: "" }, package: { jobId } } })).toBe(0);

    await mk(jobId, "follow_up", 2, "sent", { sentAt: new Date("2026-03-24T10:00:00Z") });
    expect(await getFollowUpDue(userA, jobId, new Date("2026-04-01T00:00:00Z"))).toEqual({
      eligible: false,
      reason: "complete",
    });
  });

  it("is not eligible for apply-via-link, an unsent application, a non-applied job", async () => {
    const link = await newJob(userA, appliedId);
    await mk(link, "application", 1, "sent", { emailTo: null, sentVia: "manual" });
    expect(await getFollowUpDue(userA, link, DAY9)).toMatchObject({ reason: "no_recipient" });

    const unsent = await newJob(userA, appliedId);
    await mk(unsent, "application", 1, "approved");
    expect(await getFollowUpDue(userA, unsent, DAY9)).toMatchObject({ reason: "no_sent_application" });

    const moved = await newJob(userA, interviewId);
    await mk(moved, "application", 1, "sent");
    expect(await getFollowUpDue(userA, moved, DAY9)).toMatchObject({ reason: "job_not_applied" });

    // A sent follow-up alone is not an application.
    const onlyFu = await newJob(userA, appliedId);
    await mk(onlyFu, "follow_up", 1, "sent");
    expect(await getFollowUpDue(userA, onlyFu, DAY9)).toMatchObject({ reason: "no_sent_application" });
  });

  it("is NOT_FOUND for another user's job", async () => {
    const { jobId } = await appliedJob();
    await expect(getFollowUpDue(userB, jobId, DAY9)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("snooze, skip, stop", () => {
  it("snooze 3 and 7 days: lazily creates the row, hides the step, replaces an earlier snooze", async () => {
    const { jobId } = await appliedJob();
    expect(await getFollowUpState(userA, jobId)).toBeNull();
    const s3 = await snoozeFollowUp(userA, jobId, 3, DAY9);
    expect(s3.snoozedUntil?.toISOString()).toBe("2026-03-12T12:00:00.000Z");
    expect(await getFollowUpDue(userA, jobId, new Date("2026-03-10T00:00:00Z"))).toMatchObject({ status: "snoozed" });
    expect(await getFollowUpDue(userA, jobId, new Date("2026-03-12T12:00:00Z"))).toMatchObject({ status: "due" });
    const s7 = await snoozeFollowUp(userA, jobId, 7, new Date("2026-03-10T00:00:00Z"));
    expect(s7.snoozedUntil?.toISOString()).toBe("2026-03-17T00:00:00.000Z");
    expect(await prisma.jobFollowUp.count({ where: { jobId } })).toBe(1);
  });

  it("snooze refuses other lengths (VALIDATION) and steps that are not due (INVALID_STATE), writing nothing", async () => {
    const { jobId } = await appliedJob();
    for (const days of [0, 1, 5, 30, -3, NaN]) {
      await expect(snoozeFollowUp(userA, jobId, days, DAY9)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    // Before the due day, and after the window.
    await expect(snoozeFollowUp(userA, jobId, 3, new Date("2026-03-03T00:00:00Z"))).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expect(snoozeFollowUp(userA, jobId, 3, new Date("2026-09-01T00:00:00Z"))).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect(await prisma.jobFollowUp.count({ where: { jobId } })).toBe(0);
  });

  it("skip moves the marker to the step number, ends the snooze and re-anchors step 2 at the skip date", async () => {
    const { jobId } = await appliedJob();
    await snoozeFollowUp(userA, jobId, 7, DAY9);
    const s = await skipFollowUpStep(userA, jobId, DAY9);
    expect(s).toMatchObject({ skippedThrough: 1, snoozedUntil: null });
    expect(s.skippedAt?.toISOString()).toBe(DAY9.toISOString());
    const next = await getFollowUpDue(userA, jobId, new Date("2026-03-20T00:00:00Z"));
    expect(next).toMatchObject({ eligible: true, step: 2, status: "scheduled" });
    // Skip step 2 as well: nothing left.
    const s2 = await skipFollowUpStep(userA, jobId, new Date("2026-03-23T12:00:00Z"));
    expect(s2.skippedThrough).toBe(2);
    expect(await getFollowUpDue(userA, jobId, new Date("2026-03-24T12:00:00Z"))).toEqual({
      eligible: false,
      reason: "complete",
    });
    await expect(skipFollowUpStep(userA, jobId, new Date("2026-03-25T12:00:00Z"))).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
  });

  it("skip works on a step that is still scheduled but not on an expired one", async () => {
    const { jobId } = await appliedJob();
    expect((await skipFollowUpStep(userA, jobId, new Date("2026-03-03T00:00:00Z"))).skippedThrough).toBe(1);
    const old = await appliedJob();
    await expect(skipFollowUpStep(userA, old.jobId, new Date("2026-09-01T00:00:00Z"))).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
  });

  it("stop ends suggestions, is idempotent, and leaves an open draft alone", async () => {
    const { jobId } = await appliedJob();
    const draft = await mk(jobId, "follow_up", 1, "pending");
    expect((await stopFollowUps(userA, jobId)).stopped).toBe(true);
    expect((await stopFollowUps(userA, jobId)).stopped).toBe(true);
    expect(await getFollowUpDue(userA, jobId, DAY9)).toEqual({ eligible: false, reason: "stopped" });
    expect((await row(draft.id)).status).toBe("pending");
  });

  it("stop needs a sent application", async () => {
    const jobId = await newJob(userA, appliedId);
    await expect(stopFollowUps(userA, jobId)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await prisma.jobFollowUp.count({ where: { jobId } })).toBe(0);
  });
});

describe("outcome and undo", () => {
  it("records each outcome, replaces an earlier one, and stops suggestions", async () => {
    const { jobId } = await appliedJob();
    for (const outcome of ["replied", "interview", "rejected", "closed"] as const) {
      const { state } = await setFollowUpOutcome(userA, jobId, outcome, DAY9);
      expect(state).toMatchObject({ outcome });
      expect(state.outcomeAt?.toISOString()).toBe(DAY9.toISOString());
    }
    expect(await getFollowUpDue(userA, jobId, DAY9)).toEqual({ eligible: false, reason: "outcome" });
    expect(await prisma.jobFollowUp.count({ where: { jobId } })).toBe(1);
  });

  it("refuses an unknown outcome and a job without a sent application", async () => {
    const { jobId } = await appliedJob();
    await expect(setFollowUpOutcome(userA, jobId, "ghosted", DAY9)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(setFollowUpOutcome(userA, jobId, "", DAY9)).rejects.toMatchObject({ code: "VALIDATION" });
    const unsent = await newJob(userA, appliedId);
    await mk(unsent, "application", 1, "approved");
    await expect(setFollowUpOutcome(userA, unsent, "replied", DAY9)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect(await prisma.jobFollowUp.count({ where: { jobId: { in: [jobId, unsent] } } })).toBe(0);
  });

  it("supersedes open follow-up drafts (pending, approved, changes_requested), not locked ones, sent ones or the application", async () => {
    const { jobId, app } = await appliedJob();
    const pending = await mk(jobId, "follow_up", 1, "pending");
    const approved = await mk(jobId, "follow_up", 2, "approved");
    const changes = await mk(jobId, "follow_up", 3, "changes_requested", { changeRequest: "x" });
    const locked = await mk(jobId, "follow_up", 4, "approved", { sendStartedAt: new Date() });
    const sent = await mk(jobId, "follow_up", 5, "sent");
    const { supersededIds } = await setFollowUpOutcome(userA, jobId, "replied", DAY9);
    expect([...supersededIds].sort()).toEqual([pending.id, approved.id, changes.id].sort());
    expect((await row(pending.id)).status).toBe("superseded");
    expect((await row(approved.id)).status).toBe("superseded");
    const c = await row(changes.id);
    expect(c.status).toBe("superseded");
    expect(c.changeRequestHandledAt).not.toBeNull();
    expect((await row(locked.id)).status).toBe("approved");
    expect((await row(sent.id)).status).toBe("sent");
    expect((await row(app.id)).status).toBe("sent");
  });

  it("an application draft on the same job is not superseded", async () => {
    const jobId = await newJob(userA, appliedId);
    await mk(jobId, "application", 1, "sent");
    const second = await mk(jobId, "application", 2, "pending");
    await setFollowUpOutcome(userA, jobId, "closed", DAY9);
    expect((await row(second.id)).status).toBe("pending");
  });

  it("undo clears the outcome and the date, re-arms suggestions, and fails when there is none", async () => {
    const { jobId } = await appliedJob();
    await expect(undoFollowUpOutcome(userA, jobId)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await setFollowUpOutcome(userA, jobId, "replied", DAY9);
    const s = await undoFollowUpOutcome(userA, jobId);
    expect(s).toMatchObject({ outcome: null, outcomeAt: null });
    expect(await getFollowUpDue(userA, jobId, DAY9)).toMatchObject({ eligible: true, step: 1, status: "due" });
    await expect(undoFollowUpOutcome(userA, jobId)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("undo keeps stop, skip and snooze as they were", async () => {
    const { jobId } = await appliedJob();
    await skipFollowUpStep(userA, jobId, DAY9);
    await stopFollowUps(userA, jobId);
    await setFollowUpOutcome(userA, jobId, "interview", DAY9);
    expect(await undoFollowUpOutcome(userA, jobId)).toMatchObject({
      outcome: null,
      stopped: true,
      skippedThrough: 1,
    });
  });
});

describe("rejecting a follow-up draft skips its step", () => {
  it("rejecting follow-up 1 skips step 1, rejecting follow-up 2 skips step 2", async () => {
    const { jobId } = await appliedJob();
    const f1 = await mk(jobId, "follow_up", 1, "pending");
    await rejectPackage(userA, f1.id, "not now");
    expect(await getFollowUpState(userA, jobId)).toMatchObject({ skippedThrough: 1 });
    expect(await getFollowUpDue(userA, jobId, new Date("2026-03-20T00:00:00Z"))).toMatchObject({
      step: 2,
      status: "scheduled",
    });
    const f2 = await mk(jobId, "follow_up", 2, "approved");
    await rejectPackage(userA, f2.id, "no thanks");
    expect(await getFollowUpState(userA, jobId)).toMatchObject({ skippedThrough: 2 });
    expect(await getFollowUpDue(userA, jobId, new Date("2026-04-30T00:00:00Z"))).toMatchObject({
      reason: "complete",
    });
  });

  it("rejecting an application draft does not create or change follow-up state", async () => {
    const jobId = await newJob(userA);
    const a = await mk(jobId, "application", 1, "pending");
    await rejectPackage(userA, a.id, "no");
    expect(await prisma.jobFollowUp.count({ where: { jobId } })).toBe(0);
  });

  it("a failed reject (wrong state) leaves the state alone", async () => {
    const { jobId } = await appliedJob();
    const sent = await mk(jobId, "follow_up", 1, "sent");
    await expect(rejectPackage(userA, sent.id, "x")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await prisma.jobFollowUp.count({ where: { jobId } })).toBe(0);
  });
});

describe("every follow-up action is scoped by userId", () => {
  it("another user's job: NOT_FOUND, nothing written, nothing superseded", async () => {
    const { jobId } = await appliedJob(userA);
    const draft = await mk(jobId, "follow_up", 1, "pending");
    await expect(snoozeFollowUp(userB, jobId, 3, DAY9)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(skipFollowUpStep(userB, jobId, DAY9)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(stopFollowUps(userB, jobId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(setFollowUpOutcome(userB, jobId, "replied", DAY9)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(undoFollowUpOutcome(userB, jobId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.jobFollowUp.count({ where: { jobId } })).toBe(0);
    expect((await row(draft.id)).status).toBe("pending");
    expect(await getFollowUpState(userB, jobId)).toBeNull();
  });

  it("the state row of user A is not visible or writable through user B", async () => {
    const { jobId } = await appliedJob(userA);
    await stopFollowUps(userA, jobId);
    expect(await getFollowUpState(userB, jobId)).toBeNull();
    await expect(undoFollowUpOutcome(userB, jobId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await getFollowUpState(userA, jobId)).toMatchObject({ stopped: true });
  });
});

describe("configuration", () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  it("COCKPIT_TIMEZONE defaults to UTC and falls back to UTC when invalid", () => {
    delete process.env.COCKPIT_TIMEZONE;
    expect(getFollowUpTimezone()).toBe("UTC");
    process.env.COCKPIT_TIMEZONE = "Europe/Paris";
    expect(getFollowUpTimezone()).toBe("Europe/Paris");
    process.env.COCKPIT_TIMEZONE = "Mars/Olympus";
    expect(getFollowUpTimezone()).toBe("UTC");
  });

  it("COCKPIT_FOLLOWUP_WINDOW_DAYS defaults to 30; only whole numbers 1..365 are taken", () => {
    delete process.env.COCKPIT_FOLLOWUP_WINDOW_DAYS;
    expect(getFollowUpWindowDays()).toBe(30);
    for (const [raw, expected] of [
      ["14", 14],
      [" 60 ", 60],
      ["365", 365],
      ["0", 30],
      ["366", 30],
      ["-5", 30],
      ["abc", 30],
      ["12.5", 30],
      ["", 30],
    ] as const) {
      process.env.COCKPIT_FOLLOWUP_WINDOW_DAYS = raw;
      expect(getFollowUpWindowDays(), raw).toBe(expected);
    }
  });

  it("the database path uses the configured timezone and window", async () => {
    const { jobId } = await appliedJob();
    process.env.COCKPIT_TIMEZONE = "Pacific/Auckland";
    process.env.COCKPIT_FOLLOWUP_WINDOW_DAYS = "5";
    // Sent Monday 03-02 10:00Z = 23:00 NZDT Monday; +7 = Monday 03-09 NZDT.
    const r = await getFollowUpDue(userA, jobId, new Date("2026-03-08T11:00:00Z"));
    expect(r).toMatchObject({ eligible: true, step: 1, status: "due" });
    if (r.eligible) {
      expect(r.dueAt.toISOString()).toBe("2026-03-08T11:00:00.000Z");
      expect(r.windowEnd.toISOString()).toBe("2026-03-13T11:00:00.000Z");
    }
  });
});
