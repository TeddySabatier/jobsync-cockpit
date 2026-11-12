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
import { gmailThreadUrl, type FollowUpSummary } from "./followUpView";

// Follow-up domain service (V1 plan 3.1-3.3, D-031): the follow-up state of a
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

// Skip the current step. Only a step that is due or snoozed can be skipped (like
// snooze), so a double click or skip-then-reject cannot skip both steps from one
// intent: after a skip the next step is "scheduled" and refuses. The marker
// moves to this step's number, so the next step counts from now (the skip date);
// a skip also ends its snooze and, in the same transaction, supersedes the open
// (non-locked) follow-up drafts, like an outcome does.
export async function skipFollowUpStep(
  userId: string,
  jobId: string,
  now: Date = new Date(),
): Promise<FollowUpStateView> {
  return prisma.$transaction(async (tx) => {
    const due = await getFollowUpDue(userId, jobId, now, tx);
    if (!due.eligible || (due.status !== "due" && due.status !== "snoozed")) {
      throw new CockpitError("INVALID_STATE");
    }
    const state = await writeState(tx, userId, jobId, {
      skippedThrough: due.step,
      skippedAt: now,
      snoozedUntil: null,
    });
    await supersedeOpenFollowUps(tx, userId, jobId, now);
    return state;
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
// otherwise). Since D-042 (b) it also supersedes the open (not locked) follow-up
// drafts, like skip and an outcome: a draft that can no longer be sent must not
// stay in To do. A locked draft is left alone; the send-time recheck refuses it.
export async function stopFollowUps(
  userId: string,
  jobId: string,
  now: Date = new Date(),
): Promise<FollowUpStateView> {
  return prisma.$transaction(async (tx) => {
    await requireSentApplication(tx, userId, jobId);
    const state = await writeState(tx, userId, jobId, { stopped: true });
    await supersedeOpenFollowUps(tx, userId, jobId, now);
    return state;
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

// ---------------------------------------------------------------------------
// The two outcome toggles of the review UI (D-042 c)
// ---------------------------------------------------------------------------

// The outcomes the review page offers as toggles. "rejected" means "Rejected /
// closed": it also moves the job to the "rejected" status.
export const UI_OUTCOMES = ["replied", "rejected"] as const;
export type UiOutcome = (typeof UI_OUTCOMES)[number];

async function setJobStatusByValue(
  tx: Db,
  userId: string,
  jobId: string,
  value: string,
  onlyFrom?: string,
): Promise<void> {
  const status = await tx.jobStatus.findUnique({ where: { value }, select: { id: true } });
  if (!status) throw new CockpitError("INTERNAL");
  await tx.job.updateMany({
    where: { id: jobId, userId, ...(onlyFrom ? { Status: { value: onlyFrom } } : {}) },
    data: { statusId: status.id },
  });
}

// Set or clear the outcome of a sent application, in one transaction:
// - "replied": stops follow-ups (the outcome does) and supersedes open drafts;
//   the job status is not touched.
// - "rejected" (Rejected / closed): the same, and the job status becomes
//   "rejected".
// - null (the pressed toggle pressed again): clears the outcome.
// Leaving "rejected" (to null or to "replied") puts a job that is still
// "rejected" back to "applied", so the toggle undoes what it did; a status the
// owner changed by hand since then is left alone.
export async function setApplicationOutcome(
  userId: string,
  jobId: string,
  outcome: string | null,
  now: Date = new Date(),
): Promise<FollowUpStateView> {
  if (outcome !== null && !(UI_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new CockpitError("VALIDATION");
  }
  return prisma.$transaction(async (tx) => {
    await requireSentApplication(tx, userId, jobId);
    const before = await tx.jobFollowUp.findFirst({
      where: { jobId, userId },
      select: { outcome: true },
    });
    const state = await writeState(tx, userId, jobId, {
      outcome,
      outcomeAt: outcome ? now : null,
    });
    if (outcome) await supersedeOpenFollowUps(tx, userId, jobId, now);
    if (outcome === "rejected") {
      await setJobStatusByValue(tx, userId, jobId, "rejected");
    } else if (before?.outcome === "rejected") {
      await setJobStatusByValue(tx, userId, jobId, "applied", "rejected");
    }
    return state;
  });
}

// ---------------------------------------------------------------------------
// What the review UI shows (D-042)
// ---------------------------------------------------------------------------

// The follow-up state of one job for the review page and the queue rows, or
// null when the job is not the user's. Dates stay Date objects; the thread URL
// is built from the application's own SentEmail row (a thread id, never a
// token).
export async function getFollowUpSummary(
  userId: string,
  jobId: string,
  now: Date = new Date(),
): Promise<FollowUpSummary | null> {
  const input = await loadDueInput(prisma, userId, jobId, now);
  if (!input) return null;
  const [application, state] = await Promise.all([
    prisma.applicationPackage.findFirst({
      where: sentApplicationWhere({ jobId, userId }),
      orderBy: { version: "desc" },
      select: { id: true, sentAt: true, sentEmail: { select: { threadId: true } } },
    }),
    prisma.jobFollowUp.findFirst({
      where: { jobId, userId },
      select: { outcome: true, stopped: true },
    }),
  ]);
  const due = computeFollowUpDue(input);
  return {
    jobId,
    outcome: state?.outcome ?? null,
    stopped: state?.stopped ?? false,
    step: due.eligible ? due.step : null,
    status: due.eligible ? due.status : null,
    reason: due.eligible ? null : due.reason,
    dueAt: due.eligible ? due.dueAt : null,
    snoozedUntil: due.eligible ? due.snoozedUntil : null,
    threadUrl: gmailThreadUrl(application?.sentEmail?.threadId),
    applicationSentAt: application?.sentAt ?? null,
    applicationPackageId: application?.id ?? null,
  };
}

// The step number a follow-up package stands for: a sent one by its rank among
// the sent follow-ups of its job, an open one by the step that is next (else
// one more than the sent ones). Shown as "Follow-up 1" / "Follow-up 2".
export async function followUpStepOf(
  userId: string,
  pkg: { jobId: string; status: string; sentAt: Date | null },
  summary: Pick<FollowUpSummary, "step"> | null,
): Promise<1 | 2> {
  const sent = await prisma.applicationPackage.findMany({
    where: { jobId: pkg.jobId, userId, kind: "follow_up", status: "sent" },
    select: { sentAt: true },
  });
  let n: number;
  if (pkg.status === "sent") {
    const at = pkg.sentAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    n = sent.filter((s) => (s.sentAt?.getTime() ?? 0) <= at).length;
  } else {
    n = summary?.step ?? sent.length + 1;
  }
  return n >= 2 ? 2 : 1;
}
