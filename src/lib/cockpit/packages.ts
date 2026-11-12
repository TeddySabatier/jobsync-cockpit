import { Prisma, type ApplicationPackage } from "@prisma/client";
import prisma from "@/lib/db";
import { log } from "@/lib/telemetry";
import {
  ACTIVE_PACKAGE_ORDER,
  activePackageWhere,
  sentApplicationWhere,
  type PackageKind,
} from "./activePackage";
import { walkCvLeaves } from "./cvLeaves";
import { CockpitError } from "./errors";
import { resolveCockpitFile } from "./files";
import { skipNextStepInTx } from "./followUps";
import { sortTodoRows, tabCounts } from "./queueOrder";
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

// What a package is created from. The application input (the MCP schema) with
// the fit grade optional: a follow-up has no fit grade (D-034).
export type SubmitPackageInput = Omit<SubmitApplicationPackageInput, "fitGrade"> & {
  fitGrade?: "A" | "B";
};

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

// Same key, same job and same kind: the existing package. Same key, other job
// or other kind: CONFLICT (D-008), so the bot never believes a different job, or
// an application instead of a follow-up, was submitted.
function replay(
  existing: ApplicationPackage,
  jobId: string,
  kind: PackageKind,
): SubmitResult {
  if (existing.jobId !== jobId || existing.kind !== kind) {
    throw new CockpitError("CONFLICT");
  }
  return { package: existing, supersededIds: [], idempotent: true };
}

const RETRYABLE_PRISMA_CODES = ["P2034", "P1008", "P2028"];

// D-031. The default is the V0 behaviour (an application). A "follow_up" keeps
// its own version sequence, its own active package, supersede set and send-lock
// check. It is NOT blocked by an earlier sent follow-up (ALREADY_SENT is the
// application rule; the two-step cap and every other follow-up rule is
// followUpDue.ts), and a rejected follow-up does not block a later one (a
// rejected draft counts as a skipped step). Whether the job may get a follow-up
// at all (eligibility, outcome, stopped) is the caller's check, not this one's:
// pass it as `assertAllowed`, so it runs in the insert's transaction.
export type SubmitOptions = {
  kind?: PackageKind;
  // follow_up only: the application it replies to.
  replyToPackageId?: string | null;
  // The caller's own precondition, run inside the transaction after the job
  // check and the idempotent replay (a replay skips it) and before any write.
  // Throw a CockpitError to refuse: nothing is superseded or created.
  assertAllowed?: (tx: Db) => Promise<void>;
};

export async function submitPackage(
  userId: string,
  input: SubmitPackageInput,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const kind: PackageKind = opts.kind ?? "application";
  try {
    return await prisma.$transaction((tx) =>
      submitInTransaction(
        tx,
        userId,
        input,
        kind,
        opts.replyToPackageId ?? null,
        opts.assertAllowed,
      ),
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
      if (existing) return replay(existing, input.jobId, kind);
    }
    // Version race (or anything else unique): the caller replays the submit.
    throw new CockpitError("CONFLICT");
  }
}

// contactSource is one line of bot-supplied text shown next to the recipient
// (D-041). Control characters (CR/LF, tab), zero-width and bidi-override
// characters become a space, so the line cannot be split, hidden or shown
// reversed; runs of spaces collapse. Blank is null.
// Code point ranges (inclusive): C0 / C1 controls, soft hyphen, Arabic letter
// mark, Mongolian vowel separator, zero-width and directional marks, line /
// paragraph separators and bidi embeddings / overrides, word joiner and bidi
// isolates, BOM.
const CONTACT_SOURCE_STRIP: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff],
];
const stripped = (cp: number) => CONTACT_SOURCE_STRIP.some(([lo, hi]) => cp >= lo && cp <= hi);
export function cleanContactSource(v: string | null | undefined): string | null {
  const s = Array.from(v ?? "", (ch) => (stripped(ch.codePointAt(0)!) ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

async function submitInTransaction(
  tx: Db,
  userId: string,
  input: SubmitPackageInput,
  kind: PackageKind,
  replyToPackageId: string | null,
  assertAllowed?: (tx: Db) => Promise<void>,
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
    if (existing) return replay(existing, job.id, kind);
  }

  // 2b. The caller's precondition (submit_follow_up: the step is due), in this
  // transaction so an outcome, skip or stop committed meanwhile is seen.
  if (assertAllowed) await assertAllowed(tx);

  // 3. A sent application blocks every later application (no double apply).
  // Per kind: a sent follow-up is not an application, and does not block the
  // next follow-up (the cap is followUpDue.ts).
  if (kind === "application") {
    const sent = await tx.applicationPackage.findFirst({
      where: sentApplicationWhere({ jobId: job.id }),
      select: { id: true },
    });
    if (sent) throw new CockpitError("ALREADY_SENT");

    // 4. The user said no to this job.
    const active = await tx.applicationPackage.findFirst({
      where: activePackageWhere({ jobId: job.id }, "application"),
      orderBy: ACTIVE_PACKAGE_ORDER,
      select: { status: true },
    });
    if (active?.status === "rejected") throw new CockpitError("JOB_REJECTED");
  }

  // 5. A send is in progress or unresolved: resolve it in the UI first.
  const locked = await tx.applicationPackage.findFirst({
    where: { jobId: job.id, kind, sendStartedAt: { not: null } },
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

  // 7. Next version, per (job, kind).
  const max = await tx.applicationPackage.aggregate({
    where: { jobId: job.id, kind },
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
      kind,
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
      kind,
      replyToPackageId: kind === "follow_up" ? replyToPackageId : null,
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
      contactSource: cleanContactSource(input.contactSource),
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
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await transition(tx, userId, id, ["pending", "approved"], {
      status: "rejected",
      rejectReason: text || null,
      rejectedAt: now,
    });
    // Rejecting a follow-up draft skips that step, so the bot is not asked to
    // draft it again (V1 plan 3.1, D-031). In the same transaction.
    const pkg = await tx.applicationPackage.findFirst({
      where: { id, userId },
      select: { kind: true, jobId: true },
    });
    if (pkg?.kind === "follow_up") {
      await skipNextStepInTx(tx, userId, pkg.jobId, now);
    }
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
      select: { jobId: true, kind: true, version: true },
    });
    if (!pkg) throw new CockpitError("NOT_FOUND");
    // Rejecting a follow-up draft skipped its step (D-031): not undoable here.
    if (pkg.kind === "follow_up") throw new CockpitError("INVALID_STATE");
    // Another live package of the job, or a newer non-superseded application
    // version (e.g. a later rejected one): only the job's active application may
    // come back, otherwise the bot's JOB_REJECTED guard (active package) and the
    // queue would disagree about this job.
    const other = await tx.applicationPackage.findFirst({
      where: {
        jobId: pkg.jobId,
        userId,
        id: { not: id },
        OR: [
          { status: { in: ["pending", "approved", "changes_requested", "sent"] } },
          { kind: "application", status: { not: "superseded" }, version: { gt: pkg.version } },
        ],
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
// Applications only, like the To do tab (listPackagesByTab): a follow-up draft
// is not in that list, so it must not be in the badge either.
export function countTodo(userId: string): Promise<number> {
  return prisma.applicationPackage.count({
    where: { userId, kind: "application", status: { in: QUEUE_TAB_STATUSES.todo } },
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
      // Applications only until F-4 (D-031): a follow-up never marks a job applied.
      { kind: "application", OR: [{ emailTo: null }, { emailTo: "" }] },
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
// §2.2 a job never has two non-superseded packages of a kind (a submit
// supersedes the open ones; sent/rejected block further submits), so filtering
// on the tab statuses is enough. Newest first. The queue tabs list applications
// only (D-031): follow-up drafts have their own tab, so the default is
// "application".
export async function listPackagesByTab(
  userId: string,
  tab: QueueTab,
  kind: PackageKind = "application",
) {
  const rows = await prisma.applicationPackage.findMany({
    where: { userId, kind, status: { in: QUEUE_TAB_STATUSES[tab] } },
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
      sendOutcome: true,
      sendStartedAt: true,
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
  // To do: send-unknown first, then approved, then pending (D-040).
  return tab === "todo" ? sortTodoRows(rows) : rows;
}

// One count per tab, from a single groupBy (no rows are loaded). Same kind
// scope as listPackagesByTab, so a tab count matches its list (follow-up
// drafts are not counted in the application tabs, D-031).
export async function countPackagesByTab(
  userId: string,
  kind: PackageKind = "application",
): Promise<Record<QueueTab, number>> {
  const groups = await prisma.applicationPackage.groupBy({
    by: ["status"],
    where: { userId, kind },
    _count: { _all: true },
  });
  return tabCounts(
    groups.map((g) => ({ status: g.status, count: g._count._all })),
    QUEUE_TAB_STATUSES,
  );
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

// All versions of one kind of a job, newest first (version selector). Versions
// are numbered per (job, kind), so the two kinds are separate lists.
export function listJobVersions(
  userId: string,
  jobId: string,
  kind: PackageKind = "application",
) {
  return prisma.applicationPackage.findMany({
    where: { userId, jobId, kind },
    orderBy: { version: "desc" },
    select: { id: true, version: true, status: true },
  });
}
