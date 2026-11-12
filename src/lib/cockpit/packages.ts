import { Prisma, type ApplicationPackage } from "@prisma/client";
import prisma from "@/lib/db";
import { log } from "@/lib/telemetry";
import { ACTIVE_PACKAGE_ORDER, activePackageWhere } from "./activePackage";
import { walkCvLeaves } from "./cvLeaves";
import { CockpitError } from "./errors";
import { resolveCockpitFile } from "./files";
import {
  MarkChangeRequestDoneSchema,
  RejectPackageSchema,
  RequestPackageChangesSchema,
  UpdatePackageContentSchema,
  type SubmitApplicationPackageInput,
} from "./schemas";

// Package domain service (cockpit/SPEC.md §2.1, §2.2). Every function takes the
// userId that the caller got from requireUser() / the token, and scopes every
// query with it. Every transition, edit and supersede `where` includes
// `sendStartedAt: null`: a send lock freezes the package.

export type PackageStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "sent"
  | "superseded";

export type QueueTab = "todo" | "changes" | "sent" | "rejected";

export const QUEUE_TAB_STATUSES: Record<QueueTab, PackageStatus[]> = {
  todo: ["pending", "approved"],
  changes: ["changes_requested"],
  sent: ["sent"],
  rejected: ["rejected"],
};

type Db = Prisma.TransactionClient;

export type SubmitResult = {
  package: ApplicationPackage;
  supersededIds: string[];
  idempotent: boolean;
};

// ---------------------------------------------------------------------------
// Submit (SPEC §2.2)
// ---------------------------------------------------------------------------

function p2002Target(e: unknown): string | null {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (e.code !== "P2002") return null;
  const target = e.meta?.target;
  return Array.isArray(target) ? target.join(",") : String(target ?? "");
}

// Same key, same job: the existing package. Same key, other job: CONFLICT
// (D-008), so the bot never believes a different job was submitted.
function replay(existing: ApplicationPackage, jobId: string): SubmitResult {
  if (existing.jobId !== jobId) throw new CockpitError("CONFLICT");
  return { package: existing, supersededIds: [], idempotent: true };
}

const RETRYABLE_PRISMA_CODES = ["P2034", "P1008", "P2028"];

export async function submitPackage(
  userId: string,
  input: SubmitApplicationPackageInput,
): Promise<SubmitResult> {
  try {
    return await prisma.$transaction((tx) =>
      submitInTransaction(tx, userId, input),
    );
  } catch (e) {
    // Write conflict / deadlock (P2034), and what SQLite busy under concurrent
    // writers really raises on Prisma: P1008 (gave up waiting for the write
    // lock) or P2028 (transaction could not start / expired). The transaction
    // rolled back, so the caller replays the submit, same as a version race.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      RETRYABLE_PRISMA_CODES.includes(e.code)
    ) {
      // Code only: a deterministic cause must leave a trace.
      log.warn("cockpit: submit write conflict, CONFLICT returned", {
        prismaCode: e.code,
      });
      throw new CockpitError("CONFLICT");
    }
    const target = p2002Target(e);
    if (target === null) throw e;
    // Idempotency race: the loser returns the winner's package.
    if (target.includes("idempotencyKey") && input.idempotencyKey) {
      const existing = await prisma.applicationPackage.findFirst({
        where: { userId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) return replay(existing, input.jobId);
    }
    // Version race (or anything else unique): the caller replays the submit.
    throw new CockpitError("CONFLICT");
  }
}

async function submitInTransaction(
  tx: Db,
  userId: string,
  input: SubmitApplicationPackageInput,
): Promise<SubmitResult> {
  // 1. The job must belong to the user.
  const job = await tx.job.findFirst({
    where: { id: input.jobId, userId },
    select: { id: true },
  });
  if (!job) throw new CockpitError("NOT_FOUND");

  // 2. Idempotent replay: same package, no new version.
  if (input.idempotencyKey) {
    const existing = await tx.applicationPackage.findFirst({
      where: { userId, idempotencyKey: input.idempotencyKey },
    });
    if (existing) return replay(existing, job.id);
  }

  // 3. Any past sent package blocks every later submit (no double apply).
  const sent = await tx.applicationPackage.findFirst({
    where: { jobId: job.id, status: "sent" },
    select: { id: true },
  });
  if (sent) throw new CockpitError("ALREADY_SENT");

  // 4. The user said no to this job.
  const active = await tx.applicationPackage.findFirst({
    where: activePackageWhere({ jobId: job.id }),
    orderBy: ACTIVE_PACKAGE_ORDER,
    select: { status: true },
  });
  if (active?.status === "rejected") throw new CockpitError("JOB_REJECTED");

  // 5. A send is in progress or unresolved: resolve it in the UI first.
  const locked = await tx.applicationPackage.findFirst({
    where: { jobId: job.id, sendStartedAt: { not: null } },
    select: { id: true },
  });
  if (locked) throw new CockpitError("CONFLICT");

  // 6. The CV file must live in this user's cockpit dir.
  if (input.cvFileId) {
    const file = await tx.file.findUnique({ where: { id: input.cvFileId } });
    if (!file || !(await resolveCockpitFile(userId, file))) {
      throw new CockpitError("FILE_NOT_FOUND");
    }
  }

  // 7. Next version.
  const max = await tx.applicationPackage.aggregate({
    where: { jobId: job.id },
    _max: { version: true },
  });
  const version = (max._max.version ?? 0) + 1;

  // 8. Supersede the open packages. Step 5 already refused any lock on this
  // job, so `sendStartedAt: null` below is defence in depth (the header rule:
  // every supersede `where` carries it). Two passes because only a
  // changes_requested package gets changeRequestHandledAt.
  const open = await tx.applicationPackage.findMany({
    where: {
      jobId: job.id,
      userId,
      status: { in: ["pending", "approved", "changes_requested"] },
      sendStartedAt: null,
    },
    select: { id: true, status: true },
  });
  const now = new Date();
  const plainIds = open
    .filter((p) => p.status !== "changes_requested")
    .map((p) => p.id);
  const changeIds = open
    .filter((p) => p.status === "changes_requested")
    .map((p) => p.id);
  if (plainIds.length) {
    await tx.applicationPackage.updateMany({
      where: { id: { in: plainIds }, userId, sendStartedAt: null },
      data: { status: "superseded" },
    });
  }
  if (changeIds.length) {
    await tx.applicationPackage.updateMany({
      where: { id: { in: changeIds }, userId, sendStartedAt: null },
      data: { status: "superseded", changeRequestHandledAt: now },
    });
  }

  // 9. Create. userId comes from the caller, never from the input.
  const created = await tx.applicationPackage.create({
    data: {
      userId,
      jobId: job.id,
      version,
      status: "pending",
      emailTo: input.emailTo ?? null,
      emailSubject: input.emailSubject,
      emailBody: input.emailBody,
      letterMd: input.letterMd ?? null,
      fitGrade: input.fitGrade,
      fitAnalysis: input.fitAnalysis ? JSON.stringify(input.fitAnalysis) : null,
      cvJson: input.cvJson ? JSON.stringify(input.cvJson) : null,
      cvFileId: input.cvFileId ?? null,
      sourceFolder: input.sourceFolder ?? null,
      contactSource: input.contactSource?.trim() || null,
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });
  return {
    package: created,
    supersededIds: open.map((p) => p.id),
    idempotent: false,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle transitions (SPEC §2.1)
// ---------------------------------------------------------------------------

// Conditional transition. A count of 0 is INVALID_STATE, or NOT_FOUND when the
// package does not exist for this user. `where` always carries sendStartedAt: null.
async function transition(
  db: Db | typeof prisma,
  userId: string,
  id: string,
  from: PackageStatus[],
  data: Prisma.ApplicationPackageUpdateManyMutationInput,
  extraWhere: Prisma.ApplicationPackageWhereInput = {},
): Promise<void> {
  const res = await db.applicationPackage.updateMany({
    where: {
      id,
      userId,
      status: { in: from },
      sendStartedAt: null,
      ...extraWhere,
    },
    data,
  });
  if (res.count > 0) return;
  const exists = await db.applicationPackage.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  throw new CockpitError(exists ? "INVALID_STATE" : "NOT_FOUND");
}

async function reload(userId: string, id: string): Promise<ApplicationPackage> {
  const pkg = await prisma.applicationPackage.findFirst({
    where: { id, userId },
  });
  if (!pkg) throw new CockpitError("NOT_FOUND");
  return pkg;
}

function parse<T>(
  schema: {
    safeParse(v: unknown): { success: true; data: T } | { success: false };
  },
  input: unknown,
): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new CockpitError("VALIDATION");
  return r.data;
}

export async function approvePackage(userId: string, id: string) {
  await transition(prisma, userId, id, ["pending"], {
    status: "approved",
    approvedAt: new Date(),
  });
  return reload(userId, id);
}

export async function unapprovePackage(userId: string, id: string) {
  await transition(prisma, userId, id, ["approved"], {
    status: "pending",
    approvedAt: null,
  });
  return reload(userId, id);
}

export async function rejectPackage(
  userId: string,
  id: string,
  reason?: string,
) {
  const { reason: text } = parse(RejectPackageSchema, { reason });
  await transition(prisma, userId, id, ["pending", "approved"], {
    status: "rejected",
    rejectReason: text || null,
    rejectedAt: new Date(),
  });
  return reload(userId, id);
}

// Undo a reject (D-041): back to pending, as if it had never been rejected.
// The reject reason and time are cleared (a later reject writes its own). The
// job needs no change: Reject never touched it. The bot's JOB_REJECTED guard
// looks at the job's active package, so once this one is pending again the
// bot may resubmit like for any open application. Refused (INVALID_STATE) when
// the job has another live package, which the submit rules should prevent.
export async function reopenPackage(userId: string, id: string) {
  await prisma.$transaction(async (tx) => {
    const pkg = await tx.applicationPackage.findFirst({
      where: { id, userId },
      select: { jobId: true },
    });
    if (!pkg) throw new CockpitError("NOT_FOUND");
    const other = await tx.applicationPackage.findFirst({
      where: {
        jobId: pkg.jobId,
        userId,
        id: { not: id },
        status: { in: ["pending", "approved", "changes_requested", "sent"] },
      },
      select: { id: true },
    });
    if (other) throw new CockpitError("INVALID_STATE");
    await transition(tx, userId, id, ["rejected"], {
      status: "pending",
      rejectReason: null,
      rejectedAt: null,
      approvedAt: null,
    });
  });
  return reload(userId, id);
}

// Number of To do applications (pending and approved), for the sidebar badge.
export function countTodo(userId: string): Promise<number> {
  return prisma.applicationPackage.count({
    where: { userId, status: { in: QUEUE_TAB_STATUSES.todo } },
  });
}

// A later request overwrites the previous one and resets the bot's response.
export async function requestPackageChanges(
  userId: string,
  id: string,
  instruction: string,
) {
  const { instruction: changeRequest } = parse(RequestPackageChangesSchema, {
    instruction,
  });
  await transition(prisma, userId, id, ["pending", "approved"], {
    status: "changes_requested",
    // The bot's next version needs a fresh approval.
    approvedAt: null,
    changeRequest,
    changeRequestedAt: new Date(),
    changeRequestHandledAt: null,
    changeRequestResponse: null,
  });
  return reload(userId, id);
}

// Bot side. The change-request fields stay as history (SPEC §2.1).
export async function markChangeRequestDone(
  userId: string,
  id: string,
  response: string,
) {
  const { response: changeRequestResponse } = parse(
    MarkChangeRequestDoneSchema,
    {
      packageId: id,
      response,
    },
  );
  await transition(prisma, userId, id, ["changes_requested"], {
    status: "pending",
    changeRequestResponse,
    changeRequestHandledAt: new Date(),
  });
  return reload(userId, id);
}

// Job statuses that a send (Gmail or manual) moves forward to "applied". A job
// the owner already moved further (interview, offer, ...) keeps its status
// (D-018 a); `applied` and a missing appliedDate are still set.
const PRE_APPLY_JOB_STATUSES = ["draft", "new"];

// Job -> applied (SPEC §6.4 step 6). Shared by send.ts and
// markPackageAppliedManually. Runs inside the caller's transaction: a missing
// "applied" status row is INTERNAL and rolls the whole send back.
export async function markJobApplied(
  tx: Db,
  userId: string,
  jobId: string,
  now: Date,
): Promise<void> {
  // Prisma treats `id: undefined` as "no filter": never let it through.
  if (!jobId) throw new CockpitError("INTERNAL");
  const applied = await tx.jobStatus.findUnique({ where: { value: "applied" } });
  if (!applied) throw new CockpitError("INTERNAL");
  // The status only moves forward (draft/new -> applied).
  await tx.job.updateMany({
    where: {
      id: jobId,
      userId,
      Status: { value: { in: PRE_APPLY_JOB_STATUSES } },
    },
    data: { statusId: applied.id },
  });
  // The application did happen: always flag it, whatever the status.
  await tx.job.updateMany({
    where: { id: jobId, userId },
    data: { applied: true },
  });
  // First application date wins: never overwrite an existing one.
  await tx.job.updateMany({
    where: { id: jobId, userId, appliedDate: null },
    data: { appliedDate: now },
  });
}

// Only for packages without a recipient ("apply via link"). No SentEmail row.
export async function markPackageAppliedManually(userId: string, id: string) {
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    await transition(
      tx,
      userId,
      id,
      ["pending", "approved"],
      { status: "sent", sentVia: "manual", sentAt: now },
      { OR: [{ emailTo: null }, { emailTo: "" }] },
    );
    const { jobId } = await tx.applicationPackage.findFirstOrThrow({
      where: { id, userId },
      select: { jobId: true },
    });
    await markJobApplied(tx, userId, jobId, now);
  });
  return reload(userId, id);
}

// ---------------------------------------------------------------------------
// Edit (SPEC §2.1 "Editable", §5.4)
// ---------------------------------------------------------------------------

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const leafMap = (cv: Json) =>
  new Map(
    walkCvLeaves(cv).map(({ segments, value }) => [
      JSON.stringify(segments),
      value,
    ]),
  );

// Same keys, same array lengths, same non-string values; string leaves may
// change. Compares the leaves of the shared walker (own keys only).
function compareCv(a: Json, b: Json) {
  const out = { sameShape: true, stringChanged: false };
  const la = leafMap(a);
  const lb = leafMap(b);
  if (la.size !== lb.size) return { ...out, sameShape: false };
  for (const [path, va] of la) {
    if (!lb.has(path)) return { ...out, sameShape: false };
    const vb = lb.get(path);
    if (typeof va === "string" && typeof vb === "string") {
      if (va !== vb) out.stringChanged = true;
    } else if (isObject(va) && isObject(vb)) {
      // Both empty objects.
    } else if (Array.isArray(va) && Array.isArray(vb)) {
      // Both empty arrays.
    } else if (va !== vb) {
      return { ...out, sameShape: false };
    }
  }
  return out;
}

export async function updatePackageContent(
  userId: string,
  id: string,
  input: unknown,
) {
  const patch = parse(UpdatePackageContentSchema, input);
  const current = await reload(userId, id);

  const data: Prisma.ApplicationPackageUpdateManyMutationInput = {
    editedAt: new Date(),
  };
  if (patch.emailTo !== undefined) data.emailTo = patch.emailTo;
  if (patch.emailSubject !== undefined) data.emailSubject = patch.emailSubject;
  if (patch.emailBody !== undefined) data.emailBody = patch.emailBody;
  if (patch.letterMd !== undefined) data.letterMd = patch.letterMd;
  if (patch.cvJson !== undefined) {
    if (!current.cvJson) throw new CockpitError("VALIDATION");
    const cmp = compareCv(JSON.parse(current.cvJson), patch.cvJson);
    if (!cmp.sameShape) throw new CockpitError("VALIDATION");
    data.cvJson = JSON.stringify(patch.cvJson);
    // The bot-rendered PDF no longer matches the edited text.
    if (cmp.stringChanged) data.cvPdfStale = true;
  }

  await transition(prisma, userId, id, ["pending", "approved"], data);
  return reload(userId, id);
}

// ---------------------------------------------------------------------------
// Queries (callers authenticate first and pass the userId)
// ---------------------------------------------------------------------------

// One row per job: the active package (highest non-superseded version). By
// §2.2 a job never has two non-superseded packages (a submit supersedes the
// open ones; sent/rejected block further submits), so filtering on the tab
// statuses is enough. Newest first.
export function listPackagesByTab(userId: string, tab: QueueTab) {
  return prisma.applicationPackage.findMany({
    where: { userId, status: { in: QUEUE_TAB_STATUSES[tab] } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      jobId: true,
      version: true,
      status: true,
      fitGrade: true,
      emailTo: true,
      cvFileId: true,
      cvPdfStale: true,
      createdAt: true,
      job: {
        select: {
          id: true,
          JobTitle: { select: { label: true } },
          Company: { select: { label: true } },
        },
      },
    },
  });
}

// Full package with its job and CV file row, scoped to the user.
export async function getPackageWithJob(userId: string, id: string) {
  const pkg = await prisma.applicationPackage.findFirst({
    where: { id, userId },
    include: {
      cvFile: true,
      job: {
        select: {
          id: true,
          jobUrl: true,
          description: true,
          JobTitle: { select: { label: true } },
          Company: { select: { label: true } },
        },
      },
    },
  });
  if (!pkg) throw new CockpitError("NOT_FOUND");
  return pkg;
}

// The send history of one package, oldest first (D-028). Read only; scoped to
// the user.
export function listSendHistory(userId: string, packageId: string) {
  return prisma.sendAttempt.findMany({
    where: { packageId, userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      outcome: true,
      errorCode: true,
      gmailMessageId: true,
      createdAt: true,
    },
  });
}

// All versions of a job, newest first (version selector).
export function listJobVersions(userId: string, jobId: string) {
  return prisma.applicationPackage.findMany({
    where: { userId, jobId },
    orderBy: { version: "desc" },
    select: { id: true, version: true, status: true },
  });
}
