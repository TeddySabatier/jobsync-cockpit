import type { Prisma } from "@prisma/client";
import prisma from "@/lib/db";
import { sentApplicationWhere } from "./activePackage";
import { getFollowUpTimezone, getFollowUpWindowDays } from "./config";
import { CockpitError } from "./errors";
import {
  FOLLOW_UP_OUTCOMES,
  SNOOZE_DAYS,
  computeFollowUpDue,
  snoozeUntil,
  stepProgress,
  type DueInput,
  type FollowUpDue,
  type FollowUpOutcome,
  type SnoozeDays,
} from "./followUpDue";

// Follow-up domain service (V1 plan 3.1-3.3, D-030): the follow-up state of a
// job (snooze, skip, stop, outcome, undo) and the due calculation fed from the
// database. NOT a "use server" module; the thin actions are in
// src/actions/cockpitFollowUps.actions.ts. Every function takes the userId that
// the caller got from requireUser(), scopes every query with it and uses an
// explicit select. This module never imports send or gmail (AC-35).

type Db = Prisma.TransactionClient;

// What the UI may know about a job's follow-up state.
export type FollowUpStateView = {
  outcome: FollowUpOutcome | null;
  outcomeAt: Date | null;
  stopped: boolean;
  skippedThrough: number;
  skippedAt: Date | null;
  snoozedUntil: Date | null;
};

const STATE_SELECT = {
  outcome: true,
  outcomeAt: true,
  stopped: true,
  skippedThrough: true,
  skippedAt: true,
  snoozedUntil: true,
} as const;

function toStateView(row: {
  outcome: string | null;
  outcomeAt: Date | null;
  stopped: boolean;
  skippedThrough: number;
  skippedAt: Date | null;
  snoozedUntil: Date | null;
}): FollowUpStateView {
  return {
    ...row,
    outcome: (FOLLOW_UP_OUTCOMES as readonly string[]).includes(row.outcome ?? "")
      ? (row.outcome as FollowUpOutcome)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Everything the pure calculation needs for one job, or null when the job is not
// the user's. Two package reads, both by kind: the sent application and the sent
// follow-ups (counted from packages, not from SentEmail, so a send marked
// through the recovery panel counts).
export async function loadDueInput(
  db: Db | typeof prisma,
  userId: string,
  jobId: string,
  now: Date,
  opts: { timezone?: string; windowDays?: number } = {},
): Promise<DueInput | null> {
  const job = await db.job.findFirst({
    where: { id: jobId, userId },
    select: {
      Status: { select: { value: true } },
      followUp: { select: STATE_SELECT },
    },
  });
  if (!job) return null;
  const [application, sentFollowUps] = await Promise.all([
    db.applicationPackage.findFirst({
      where: sentApplicationWhere({ jobId, userId }),
      orderBy: { version: "desc" },
      select: { sentAt: true, emailTo: true },
    }),
    db.applicationPackage.findMany({
      where: { jobId, userId, kind: "follow_up", status: "sent" },
      select: { sentAt: true },
    }),
  ]);
  return {
    now,
    jobStatus: job.Status?.value ?? null,
    application,
    sentFollowUps,
    state: job.followUp,
    timezone: opts.timezone ?? getFollowUpTimezone(),
    windowDays: opts.windowDays ?? getFollowUpWindowDays(),
  };
}

// The due state of one job. NOT_FOUND when the job is not the user's.
export async function getFollowUpDue(
  userId: string,
  jobId: string,
  now: Date = new Date(),
  db: Db | typeof prisma = prisma,
): Promise<FollowUpDue> {
  const input = await loadDueInput(db, userId, jobId, now);
  if (!input) throw new CockpitError("NOT_FOUND");
  return computeFollowUpDue(input);
}

export async function getFollowUpState(
  userId: string,
  jobId: string,
): Promise<FollowUpStateView | null> {
  const row = await prisma.jobFollowUp.findFirst({
    where: { jobId, userId },
    select: STATE_SELECT,
  });
  return row ? toStateView(row) : null;
}

// ---------------------------------------------------------------------------
// Writing the state (all scoped by userId; the job is checked first)
// ---------------------------------------------------------------------------

// The row is created lazily, keyed by the job (unique). The job is verified to
// belong to the user before the upsert, inside the same transaction.
async function writeState(
  tx: Db,
  userId: string,
  jobId: string,
  data: Partial<{
    outcome: string | null;
    outcomeAt: Date | null;
    stopped: boolean;
    skippedThrough: number;
    skippedAt: Date | null;
    snoozedUntil: Date | null;
  }>,
): Promise<FollowUpStateView> {
  const row = await tx.jobFollowUp.upsert({
    where: { jobId },
    create: { ...data, userId, jobId },
    update: data,
    select: STATE_SELECT,
  });
  return toStateView(row);
}

async function requireOwnJob(tx: Db, userId: string, jobId: string) {
  const job = await tx.job.findFirst({
    where: { id: jobId, userId },
    select: { id: true },
  });
  if (!job) throw new CockpitError("NOT_FOUND");
}

// Snooze the current step for 3 or 7 days. Only a step that is due (or already
// snoozed: snoozing again replaces the date) can be snoozed.
export async function snoozeFollowUp(
  userId: string,
  jobId: string,
  days: number,
  now: Date = new Date(),
): Promise<FollowUpStateView> {
  if (!(SNOOZE_DAYS as readonly number[]).includes(days)) {
    throw new CockpitError("VALIDATION");
  }
  return prisma.$transaction(async (tx) => {
    const due = await getFollowUpDue(userId, jobId, now, tx);
    if (!due.eligible || (due.status !== "due" && due.status !== "snoozed")) {
      throw new CockpitError("INVALID_STATE");
    }
    return writeState(tx, userId, jobId, {
      snoozedUntil: snoozeUntil(now, days as SnoozeDays),
    });
  });
}

// Skip the current step. The marker moves to this step's number, so the next
// step counts from now (the skip date). A skipped step also ends its snooze.
export async function skipFollowUpStep(
  userId: string,
  jobId: string,
  now: Date = new Date(),
): Promise<FollowUpStateView> {
  return prisma.$transaction(async (tx) => {
    const due = await getFollowUpDue(userId, jobId, now, tx);
    if (!due.eligible || due.status === "expired") {
      throw new CockpitError("INVALID_STATE");
    }
    return writeState(tx, userId, jobId, {
      skippedThrough: due.step,
      skippedAt: now,
      snoozedUntil: null,
    });
  });
}

// Skip the next step of a job without the due/eligibility checks: a rejected
// follow-up draft counts as skipping the step it was for (the draft exists, so
// the step was open). Runs inside the caller's transaction. A job whose two
// steps are already done is left alone.
export async function skipNextStepInTx(
  tx: Db,
  userId: string,
  jobId: string,
  now: Date,
): Promise<void> {
  const [state, sent] = await Promise.all([
    tx.jobFollowUp.findFirst({
      where: { jobId, userId },
      select: STATE_SELECT,
    }),
    tx.applicationPackage.findMany({
      where: { jobId, userId, kind: "follow_up", status: "sent" },
      select: { sentAt: true },
    }),
  ]);
  const { step } = stepProgress(sent, state);
  if (step === null) return;
  await writeState(tx, userId, jobId, {
    skippedThrough: step,
    skippedAt: now,
    snoozedUntil: null,
  });
}

// Stop all follow-ups of a job. Needs a sent application (nothing to stop
// otherwise). Does not touch an open draft: the send-time recheck refuses it.
export async function stopFollowUps(
  userId: string,
  jobId: string,
): Promise<FollowUpStateView> {
  return prisma.$transaction(async (tx) => {
    await requireSentApplication(tx, userId, jobId);
    return writeState(tx, userId, jobId, { stopped: true });
  });
}

async function requireSentApplication(tx: Db, userId: string, jobId: string) {
  await requireOwnJob(tx, userId, jobId);
  const sent = await tx.applicationPackage.findFirst({
    where: sentApplicationWhere({ jobId, userId }),
    select: { id: true },
  });
  if (!sent) throw new CockpitError("INVALID_STATE");
}

// Open follow-up drafts of a job go to "superseded". Frozen (locked) packages
// are not touched: a send in progress is resolved in the UI, and the send-time
// recheck refuses it. changes_requested gets changeRequestHandledAt like in a
// resubmit (packages.ts).
export async function supersedeOpenFollowUps(
  tx: Db,
  userId: string,
  jobId: string,
  now: Date,
): Promise<string[]> {
  const open = await tx.applicationPackage.findMany({
    where: {
      jobId,
      userId,
      kind: "follow_up",
      status: { in: ["pending", "approved", "changes_requested"] },
      sendStartedAt: null,
    },
    select: { id: true, status: true },
  });
  const plain = open.filter((p) => p.status !== "changes_requested").map((p) => p.id);
  const changes = open.filter((p) => p.status === "changes_requested").map((p) => p.id);
  if (plain.length) {
    await tx.applicationPackage.updateMany({
      where: { id: { in: plain }, userId, sendStartedAt: null },
      data: { status: "superseded" },
    });
  }
  if (changes.length) {
    await tx.applicationPackage.updateMany({
      where: { id: { in: changes }, userId, sendStartedAt: null },
      data: { status: "superseded", changeRequestHandledAt: now },
    });
  }
  return open.map((p) => p.id);
}

// Record the outcome (replied / interview / rejected / closed). Replaces an
// earlier outcome. Supersedes open follow-up drafts. Does not change the job
// status: the UI does that after its confirm (plan 3.6).
export async function setFollowUpOutcome(
  userId: string,
  jobId: string,
  outcome: string,
  now: Date = new Date(),
): Promise<{ state: FollowUpStateView; supersededIds: string[] }> {
  if (!(FOLLOW_UP_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new CockpitError("VALIDATION");
  }
  return prisma.$transaction(async (tx) => {
    await requireSentApplication(tx, userId, jobId);
    const state = await writeState(tx, userId, jobId, { outcome, outcomeAt: now });
    const supersededIds = await supersedeOpenFollowUps(tx, userId, jobId, now);
    return { state, supersededIds };
  });
}

// Clear the outcome. A status change that Interview / Rejected made is not
// reverted (the confirm dialog says so). INVALID_STATE when there is none.
export async function undoFollowUpOutcome(
  userId: string,
  jobId: string,
): Promise<FollowUpStateView> {
  return prisma.$transaction(async (tx) => {
    await requireOwnJob(tx, userId, jobId);
    const res = await tx.jobFollowUp.updateMany({
      where: { jobId, userId, outcome: { not: null } },
      data: { outcome: null, outcomeAt: null },
    });
    if (res.count === 0) throw new CockpitError("INVALID_STATE");
    const row = await tx.jobFollowUp.findFirstOrThrow({
      where: { jobId, userId },
      select: STATE_SELECT,
    });
    return toStateView(row);
  });
}
