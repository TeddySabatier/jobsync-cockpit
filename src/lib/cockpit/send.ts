import "server-only";
import fs from "fs/promises";
import { Prisma, type ApplicationPackage } from "@prisma/client";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { log } from "@/lib/telemetry";
import { letterAttachmentName, sanitizePdfName } from "./attachments";
import { renderLetterPdf } from "./letterPdf";
import { isGmailSendAllowed } from "./config";
import { CockpitError } from "./errors";
import { resolveCockpitFile } from "./files";
import { markJobApplied } from "./packages";
import { activeApplication, activePackageWhere, ACTIVE_PACKAGE_ORDER } from "./activePackage";
import { getFollowUpDue } from "./followUps";
import { isValidThreadId, replySubject } from "./followUpView";
import type { GmailClient } from "./gmail/client";
import { buildMimeMessage, encodeRaw, isValidMessageId, newMessageId } from "./gmail/mime";
import { UpdatePackageContentSchema } from "./schemas";

// Send service (cockpit/SPEC.md §6.4) and the two lock-recovery services.
// Callers: only src/actions/cockpitSend.actions.ts, after requireUser().
// Nothing under src/lib/mcp or src/app/api/mcp may reach this file (AC-35).
// Logging: codes, ids and statuses only. Never tokens, MIME or the body.

// 20 s Gmail timeout + margin (SPEC §6.4 "Stale lock").
export const STALE_LOCK_MS = 60_000;

export type SendResult = { id: string; sentAt: Date };

// Fields the MIME is built from, validated again at send time (defense in depth
// against rows written by older code paths, SPEC §6.4 step 1 and 3).
type Content = {
  to: string;
  subject: string;
  body: string;
  // The CV. Null for a follow-up, which carries no attachment (D-042).
  filePath: string | null;
  // Display name the recipient sees; the on-disk name is a generated uuid.
  fileName: string;
};

type PackageWithFile = ApplicationPackage & {
  cvFile: { filePath: string; fileName: string } | null;
};

// Which combinations of kind and fields this path sends (D-042). Anything else
// (an unknown kind, a follow-up that carries a CV or has no application to
// reply to, an application that claims to reply to something) is refused with
// INVALID_STATE before any side effect: such a row can only come from a
// hand-made backup or a bug, and the two kinds must never borrow each other's
// send rules (CV attachment, job -> applied).
function assertKindShape(pkg: ApplicationPackage): void {
  if (pkg.kind === "application") {
    if (pkg.replyToPackageId) throw new CockpitError("INVALID_STATE");
    return;
  }
  if (pkg.kind === "follow_up") {
    if (!pkg.replyToPackageId || pkg.cvFileId) throw new CockpitError("INVALID_STATE");
    return;
  }
  throw new CockpitError("INVALID_STATE");
}

async function checkContent(
  userId: string,
  pkg: PackageWithFile,
): Promise<Content> {
  if (pkg.kind === "follow_up") return checkFollowUpContent(pkg);
  const parsed = UpdatePackageContentSchema.safeParse({
    emailTo: pkg.emailTo ?? "",
    emailSubject: pkg.emailSubject,
    emailBody: pkg.emailBody,
  });
  if (!parsed.success) throw new CockpitError("VALIDATION");
  // The MIME is built from the validated values, never from the raw row.
  const { emailTo, emailSubject, emailBody } = parsed.data;
  if (!emailTo || emailSubject === undefined || emailBody === undefined) {
    throw new CockpitError("VALIDATION");
  }
  if (pkg.cvPdfStale) throw new CockpitError("VALIDATION");
  const filePath = pkg.cvFile
    ? await resolveCockpitFile(userId, pkg.cvFile)
    : null;
  if (!filePath) throw new CockpitError("FILE_NOT_FOUND");
  return {
    to: emailTo,
    subject: emailSubject,
    body: emailBody,
    filePath,
    fileName: sanitizePdfName(pkg.cvFile?.fileName ?? ""),
  };
}

// A follow-up: the same validation of To / Subject / Body, no CV, and the
// subject always starts with "Re: " (D-034 g; added here when the owner removed
// it, the Send dialog shows the same replySubject()).
function checkFollowUpContent(pkg: PackageWithFile): Content {
  const parsed = UpdatePackageContentSchema.safeParse({
    emailTo: pkg.emailTo ?? "",
    emailSubject: replySubject(pkg.emailSubject),
    emailBody: pkg.emailBody,
  });
  if (!parsed.success) throw new CockpitError("VALIDATION");
  const { emailTo, emailSubject, emailBody } = parsed.data;
  if (!emailTo || emailSubject === undefined || emailBody === undefined) {
    throw new CockpitError("VALIDATION");
  }
  return { to: emailTo, subject: emailSubject, body: emailBody, filePath: null, fileName: "" };
}

// Where a follow-up goes in Gmail: the thread of the application it replies to
// and, when we stored it, that email's Message-ID. Both read from the user's
// own SentEmail row only; a value that fails its strict pattern is dropped (the
// thread id alone still threads in Gmail, D-033 S1 fallback).
type ReplyContext = { threadId: string | null; inReplyTo: string | null };

// The send-time recheck of a follow-up (plan 3.3, D-042). CONFLICT when, now:
// the application it replies to is not this job's sent application any more,
// the job is not eligible (outcome recorded, follow-ups stopped, job status no
// longer "applied", both steps done), or the step it was drafted for was
// consumed (skipped or another follow-up sent: the next step is then only
// "scheduled"). A snoozed or expired step may still be sent: the owner chose to.
async function recheckFollowUp(
  userId: string,
  pkg: Pick<ApplicationPackage, "jobId" | "replyToPackageId">,
): Promise<ReplyContext> {
  if (!pkg.replyToPackageId) throw new CockpitError("INVALID_STATE");
  const original = await prisma.applicationPackage.findFirst({
    where: {
      id: pkg.replyToPackageId,
      userId,
      jobId: pkg.jobId,
      kind: "application",
    },
    select: {
      id: true,
      status: true,
      sentEmail: { select: { threadId: true, messageIdHeader: true } },
    },
  });
  if (!original || original.status !== "sent") throw new CockpitError("CONFLICT");
  const app = await activeApplication(userId, pkg.jobId);
  if (app?.id !== original.id) throw new CockpitError("CONFLICT");

  let due;
  try {
    due = await getFollowUpDue(userId, pkg.jobId, new Date());
  } catch {
    throw new CockpitError("CONFLICT");
  }
  if (!due.eligible || due.status === "scheduled") throw new CockpitError("CONFLICT");

  const threadId = original.sentEmail?.threadId ?? null;
  const header = original.sentEmail?.messageIdHeader ?? null;
  return {
    threadId: isValidThreadId(threadId) ? threadId : null,
    inReplyTo: isValidMessageId(header) ? header : null,
  };
}

type LetterAttachment = { fileName: string; content: Buffer };

// The cover letter PDF, from the letter text as it is now (D-015). No letter
// text: no second attachment. A render failure is a definitive INTERNAL.
async function buildLetterAttachment(
  pkg: { letterMd: string | null; cvJson: string | null },
  cvFileName: string,
): Promise<LetterAttachment | null> {
  if (!pkg.letterMd?.trim()) return null;
  try {
    return {
      fileName: letterAttachmentName(cvFileName),
      content: await renderLetterPdf({ letterMd: pkg.letterMd, cvJson: pkg.cvJson }),
    };
  } catch {
    log.error("cockpit: cover letter PDF could not be rendered");
    throw new CockpitError("INTERNAL");
  }
}

const withFile = (userId: string, id: string) =>
  prisma.applicationPackage.findFirst({
    where: { id, userId },
    include: { cvFile: { select: { filePath: true, fileName: true } } },
  });

// Writes to the lock this send took, and only to that one: the row is matched
// on the exact lock timestamp, so if a recovery action cleared our lock and a
// new send locked the row again, the other send's lock is never touched
// (D-022 b). Never throws. If the write fails the lock stays and the
// stale-lock rule (60 s) opens the recovery panel. True when the row matched.
async function patchOwnLock(
  userId: string,
  id: string,
  lockedAt: Date,
  data: { sendStartedAt?: null; sendOutcome: "unknown" | null },
): Promise<boolean> {
  try {
    const res = await prisma.applicationPackage.updateMany({
      where: { id, userId, status: "approved", sendStartedAt: lockedAt },
      data,
    });
    return res.count > 0;
  } catch {
    log.error("cockpit: could not update the send lock", { packageId: id });
    return false;
  }
}

export type SendAttemptOutcome =
  | "sent" // Gmail accepted the message (id known), written before the success transaction
  | "failed" // definitive: nothing was sent
  | "ambiguous" // the message may have gone out
  | "record_failed" // Gmail accepted it, the database record failed
  | "late_recorded" // lock lost, package no longer approved: recorded anyway (D-022 h)
  | "lock_lost" // Gmail accepted it, lock lost, package approved or sent: nothing recorded
  | "marked_sent" // owner: Mark as sent
  | "lock_released"; // owner: Release lock

// Append-only send history (issue #77, D-028). Insert only: nothing here or
// anywhere else updates or deletes a row, and package edits never touch it.
// Never throws, like the lock writes: the history must not turn an email that
// went out into a different error, and a failed write is only logged. Stores
// the CockpitError code, never an error message (no Gmail or Prisma text).
async function recordAttempt(
  client: Pick<typeof prisma, "sendAttempt">,
  userId: string,
  packageId: string,
  outcome: SendAttemptOutcome,
  extra: { error?: unknown; gmailMessageId?: string; threadId?: string } = {},
): Promise<void> {
  try {
    await client.sendAttempt.create({
      data: {
        userId,
        packageId,
        outcome,
        errorCode: extra.error instanceof CockpitError ? extra.error.code : null,
        gmailMessageId: extra.gmailMessageId ?? null,
        threadId: extra.threadId ?? null,
      },
    });
  } catch {
    log.error("cockpit: could not record a send attempt", {
      packageId,
      outcome,
      gmailMessageId: extra.gmailMessageId,
    });
  }
}

// After a definitive failure: nothing was sent, the package is approved again.
async function releaseQuietly(userId: string, id: string, lockedAt: Date): Promise<void> {
  await patchOwnLock(userId, id, lockedAt, { sendStartedAt: null, sendOutcome: null });
}

// The email may have gone out (or did, but could not be recorded): the lock
// stays and the outcome is flagged, so the panel offers the recovery actions.
// If our lock is already gone (a recovery action ran while Gmail was
// answering) and the row is unlocked and approved, it is locked again, so it
// cannot be sent a second time before the owner checks Gmail (D-022 c).
// A row another send has locked, or one already sent, is left alone.
async function holdAsUnknownQuietly(
  userId: string,
  id: string,
  lockedAt: Date,
): Promise<void> {
  if (await patchOwnLock(userId, id, lockedAt, { sendOutcome: "unknown" })) return;
  try {
    const res = await prisma.applicationPackage.updateMany({
      where: { id, userId, status: "approved", sendStartedAt: null },
      data: { sendStartedAt: new Date(), sendOutcome: "unknown" },
    });
    if (res.count > 0) {
      log.warn("cockpit: send lock was lost after the Gmail call; locked again", {
        packageId: id,
      });
    }
  } catch {
    log.error("cockpit: could not lock the package again", { packageId: id });
  }
}

export async function sendApplicationPackage(
  userId: string,
  packageId: string,
  expectedUpdatedAt: Date,
  gmail: GmailClient,
): Promise<SendResult> {
  // ---- Step 1: load and check, no side effects --------------------------
  const pkg = await withFile(userId, packageId);
  if (!pkg) throw new CockpitError("NOT_FOUND");
  if (
    pkg.updatedAt.getTime() !== expectedUpdatedAt.getTime() ||
    pkg.status !== "approved" ||
    pkg.sendStartedAt !== null
  ) {
    throw new CockpitError("CONFLICT");
  }
  // An application, or a follow-up that replies to one; any other shape is
  // refused (D-042). The kind is fixed for the whole send: the success step
  // marks the job applied only for an application.
  assertKindShape(pkg);
  const isFollowUp = pkg.kind === "follow_up";
  // Only the active version of its own kind may be sent (versions are numbered
  // per kind, D-031 b).
  const active = await prisma.applicationPackage.findFirst({
    where: activePackageWhere({ jobId: pkg.jobId, userId }, isFollowUp ? "follow_up" : "application"),
    orderBy: ACTIVE_PACKAGE_ORDER,
    select: { id: true },
  });
  if (active?.id !== pkg.id) throw new CockpitError("CONFLICT");
  // A follow-up must still be wanted (send-time recheck, plan 3.3).
  if (isFollowUp) await recheckFollowUp(userId, pkg);
  await checkContent(userId, pkg);

  const account = await prisma.gmailAccount.findUnique({
    where: { userId },
    select: { email: true, encryptedRefreshToken: true, iv: true },
  });
  // Not connected, allow-list unset or different address: nothing is sent.
  if (!account || !isGmailSendAllowed(account.email)) {
    throw new CockpitError("GMAIL_RECONNECT_REQUIRED");
  }

  // Rendered here, after the cheap checks and before the lock: a long letter
  // takes seconds, and the lock window (STALE_LOCK_MS) is sized for the Gmail
  // calls. Edits are refused while the lock is held, and an edit before the
  // lock fails the updatedAt condition, so the text cannot change.
  // A follow-up never carries the letter (nor the CV).
  const letterReady = isFollowUp
    ? null
    : await buildLetterAttachment(pkg, pkg.cvFile?.fileName ?? "");

  // ---- Step 2: lock (conditional, includes the updatedAt the user saw) ---
  // lockedAt identifies this send's lock in every later write (D-022 b).
  const lockedAt = new Date();
  const lock = await prisma.applicationPackage.updateMany({
    where: {
      id: packageId,
      userId,
      status: "approved",
      sendStartedAt: null,
      updatedAt: expectedUpdatedAt,
    },
    data: { sendStartedAt: lockedAt },
  });
  if (lock.count === 0) throw new CockpitError("CONFLICT");

  // ---- Steps 3-4: re-read, then everything up to the Gmail call. Any
  // failure here means nothing was sent: definitive, release the lock. ------
  let raw: string;
  let content: Content;
  let accessToken: string;
  let reply: ReplyContext | null = null;
  const messageId = newMessageId();
  try {
    const fresh = await withFile(userId, packageId);
    if (
      !fresh ||
      fresh.status !== "approved" ||
      fresh.sendStartedAt?.getTime() !== lockedAt.getTime() ||
      fresh.kind !== pkg.kind
    ) {
      throw new CockpitError("CONFLICT");
    }
    assertKindShape(fresh);
    // The recheck again, under the lock: an outcome, stop or skip recorded
    // since step 1 refuses the send before Gmail is called (definitive).
    if (isFollowUp) reply = await recheckFollowUp(userId, fresh);
    content = await checkContent(userId, fresh);
    const attachment = content.filePath
      ? { fileName: content.fileName, content: await fs.readFile(content.filePath) }
      : null;
    if (!isFollowUp && !attachment) throw new CockpitError("FILE_NOT_FOUND");
    // The cover letter PDF was made before the lock from the text the lock
    // condition (updatedAt) pinned. A letter that differs now was changed
    // behind the lock: refuse rather than render inside the lock window or
    // send a letter the owner never saw (D-022 d).
    if (fresh.letterMd !== pkg.letterMd || fresh.cvJson !== pkg.cvJson) {
      throw new CockpitError("CONFLICT");
    }
    const extraAttachments = letterReady ? [letterReady] : [];
    raw = encodeRaw(
      buildMimeMessage(
        {
          from: account.email,
          to: content.to,
          subject: content.subject,
          bodyText: content.body,
          attachment,
          extraAttachments,
          inReplyTo: reply?.inReplyTo ?? null,
        },
        { messageId },
      ),
    );
    // The only decrypt of the stored token (D-022 e). It fails when
    // ENCRYPTION_KEY is missing or changed: the user must reconnect.
    let refreshToken: string;
    try {
      refreshToken = decrypt(account.encryptedRefreshToken, account.iv);
    } catch {
      throw new CockpitError("GMAIL_RECONNECT_REQUIRED");
    }
    accessToken = await gmail.getAccessToken(refreshToken);
  } catch (e) {
    await releaseQuietly(userId, packageId, lockedAt);
    const err = e instanceof CockpitError ? e : new CockpitError("INTERNAL");
    await recordAttempt(prisma, userId, packageId, "failed", { error: err });
    if (e instanceof CockpitError) throw e;
    log.error("cockpit: send failed before Gmail call", { packageId });
    throw err;
  }

  // ---- Step 5: the Gmail call --------------------------------------------
  let sent: { id: string; threadId: string };
  try {
    // A follow-up goes into the application's Gmail thread when we know it.
    sent = reply?.threadId
      ? await gmail.sendRaw(accessToken, raw, reply.threadId)
      : await gmail.sendRaw(accessToken, raw);
  } catch (e) {
    if (e instanceof CockpitError && e.definitive === true) {
      await releaseQuietly(userId, packageId, lockedAt); // 5a: nothing was sent
      await recordAttempt(prisma, userId, packageId, "failed", { error: e });
      throw e;
    }
    // 5b: the message may have gone out. Keep the lock, flag the outcome.
    await holdAsUnknownQuietly(userId, packageId, lockedAt);
    await recordAttempt(prisma, userId, packageId, "ambiguous", { error: e });
    log.warn("cockpit: send outcome unknown", { packageId });
    throw new CockpitError("SEND_OUTCOME_UNKNOWN");
  }

  // ---- Step 5c: Gmail answered. The message id is written on its own, before
  // the success transaction, so a failure of that transaction cannot lose it
  // (issue #77, D-028). Never throws; a failed write is logged with the id.
  await recordAttempt(prisma, userId, packageId, "sent", {
    gmailMessageId: sent.id,
    threadId: sent.threadId,
  });

  // ---- Step 6: success, one transaction -----------------------------------
  const now = new Date();
  let recordedAfterLostLock = false;
  let lockLost = false;
  try {
    await prisma.$transaction(async (tx) => {
      const recordSent = async () => {
        await tx.sentEmail.create({
          data: {
            userId,
            packageId,
            fromAddress: account.email,
            toAddress: content.to,
            gmailMessageId: sent.id,
            threadId: sent.threadId,
            // The Message-ID we put in the header, for a later follow-up's
            // In-Reply-To / References (D-042).
            messageIdHeader: messageId,
            sentAt: now,
          },
        });
        // Only an application moves the job to applied; a follow-up never
        // touches the job status or appliedDate (plan 3.4).
        if (!isFollowUp) await markJobApplied(tx, userId, pkg.jobId, now);
      };
      const res = await tx.applicationPackage.updateMany({
        where: {
          id: packageId,
          userId,
          status: "approved",
          sendStartedAt: lockedAt,
        },
        data: {
          status: "sent",
          sentAt: now,
          sentVia: "gmail",
          sendOutcome: null,
        },
      });
      if (res.count > 0) {
        await recordSent();
        return;
      }
      // Our lock is gone (a recovery action ran while Gmail was answering).
      log.error("cockpit: package not in the locked approved state after send", {
        packageId,
      });
      const current = await tx.applicationPackage.findFirst({
        where: { id: packageId, userId },
        select: { status: true },
      });
      // Released then superseded, un-approved, rejected...: no panel can
      // reach this package any more, so record the fact that the email went
      // out (SentEmail row, job applied) without touching the package
      // (D-022 h). A repeat fails on the unique packageId: rolled back below.
      if (current && current.status !== "approved" && current.status !== "sent") {
        await recordSent();
        recordedAfterLostLock = true;
        return;
      }
      // Approved (released, maybe locked again) or already sent (Mark as
      // sent ran): record nothing. Throwing rolls the whole transaction
      // back; the catch below locks an approved, unlocked package again
      // with an unknown outcome (D-022 a, c).
      lockLost = true;
      throw new CockpitError("CONFLICT");
    });
  } catch {
    // The email is out but we could not record it. The lock stays (no second
    // send possible); the panel lets the user mark it as sent (SPEC §6.4).
    // The Gmail message id is already in the send history (step 5c, D-028).
    log.error("cockpit: could not record a sent email", {
      packageId,
      gmailMessageId: sent.id,
    });
    await holdAsUnknownQuietly(userId, packageId, lockedAt);
    await recordAttempt(
      prisma,
      userId,
      packageId,
      lockLost ? "lock_lost" : "record_failed",
      { gmailMessageId: sent.id, threadId: sent.threadId },
    );
    throw new CockpitError("SEND_OUTCOME_UNKNOWN");
  }
  if (recordedAfterLostLock) {
    await recordAttempt(prisma, userId, packageId, "late_recorded", {
      gmailMessageId: sent.id,
      threadId: sent.threadId,
    });
    // Recorded, but the package left the approved state before Gmail
    // answered: the owner should check Gmail and this package (D-022 h).
    log.warn("cockpit: late send recorded on a package no longer approved", {
      packageId,
      gmailMessageId: sent.id,
    });
    throw new CockpitError("SEND_OUTCOME_UNKNOWN");
  }
  return { id: packageId, sentAt: now };
}

// ---------------------------------------------------------------------------
// Recovery (SPEC §6.4): only a locked approved package whose outcome is
// unknown, or whose lock is older than STALE_LOCK_MS with no outcome.
// ---------------------------------------------------------------------------

function recoverable(userId: string, id: string): Prisma.ApplicationPackageWhereInput {
  return {
    id,
    userId,
    // Both kinds (D-042); markSendUnknownAsSent marks the job applied only for
    // an application.
    kind: { in: ["application", "follow_up"] },
    status: "approved",
    sendStartedAt: { not: null },
    OR: [
      { sendOutcome: "unknown" },
      { sendStartedAt: { lt: new Date(Date.now() - STALE_LOCK_MS) } },
    ],
  };
}

async function notRecoverable(userId: string, id: string): Promise<CockpitError> {
  const exists = await prisma.applicationPackage.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  return new CockpitError(exists ? "INVALID_STATE" : "NOT_FOUND");
}

// The user checked Gmail and the email is there: sent manually, no SentEmail
// row (no Gmail message id is known).
export async function markSendUnknownAsSent(
  userId: string,
  id: string,
): Promise<SendResult> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const res = await tx.applicationPackage.updateMany({
      where: recoverable(userId, id),
      data: { status: "sent", sentVia: "manual", sentAt: now, sendOutcome: null },
    });
    if (res.count === 0) throw await notRecoverable(userId, id);
    const pkg = await tx.applicationPackage.findFirst({
      where: { id, userId },
      select: { jobId: true, kind: true },
    });
    if (!pkg) throw new CockpitError("NOT_FOUND");
    // A follow-up marked sent counts as a sent step (followUpDue counts sent
    // packages), but never changes the job (plan 3.4).
    if (pkg.kind === "application") await markJobApplied(tx, userId, pkg.jobId, now);
    // In the same transaction: the decision and its history stand or fall
    // together. A failed history write rolls the recovery back, which is safe
    // (the lock stays and the owner can retry).
    await tx.sendAttempt
      .create({ data: { userId, packageId: id, outcome: "marked_sent" } })
      .catch(() => {
        // Rolls the recovery back: nothing changed (D-028 d).
        throw new CockpitError("HISTORY_NOT_RECORDED");
      });
  });
  return { id, sentAt: now };
}

// The email is not in Gmail: clear the lock, the package is approved again.
export async function releaseSendLock(
  userId: string,
  id: string,
): Promise<{ id: string }> {
  await prisma.$transaction(async (tx) => {
    const res = await tx.applicationPackage.updateMany({
      where: recoverable(userId, id),
      data: { sendStartedAt: null, sendOutcome: null },
    });
    if (res.count === 0) throw await notRecoverable(userId, id);
    await tx.sendAttempt
      .create({ data: { userId, packageId: id, outcome: "lock_released" } })
      .catch(() => {
        // Rolls the recovery back: nothing changed (D-028 d).
        throw new CockpitError("HISTORY_NOT_RECORDED");
      });
  });
  return { id };
}
