import "server-only";
import fs from "fs/promises";
import { Prisma, type ApplicationPackage } from "@prisma/client";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { log } from "@/lib/telemetry";
import { letterAttachmentName, sanitizePdfName } from "./attachments";
import { renderLetterPdf } from "./letterPdf";
import { CockpitError } from "./errors";
import { resolveCockpitFile } from "./files";
import type { GmailClient } from "./gmail/client";
import { buildMimeMessage, encodeRaw } from "./gmail/mime";
import { UpdatePackageContentSchema } from "./schemas";

// Send service (cockpit/SPEC.md §6.4) and the two lock-recovery services.
// Callers: only src/actions/cockpitSend.actions.ts, after requireUser().
// Nothing under src/lib/mcp or src/app/api/mcp may reach this file (AC-35).
// Logging: codes, ids and statuses only. Never tokens, MIME or the body.

// 20 s Gmail timeout + margin (SPEC §6.4 "Stale lock").
export const STALE_LOCK_MS = 60_000;

type Db = Prisma.TransactionClient;

export type SendResult = { id: string; sentAt: Date };

// Fields the MIME is built from, validated again at send time (defense in depth
// against rows written by older code paths, SPEC §6.4 step 1 and 3).
type Content = {
  to: string;
  subject: string;
  body: string;
  filePath: string;
  // Display name the recipient sees; the on-disk name is a generated uuid.
  fileName: string;
};

type PackageWithFile = ApplicationPackage & {
  cvFile: { filePath: string; fileName: string } | null;
};

async function checkContent(
  userId: string,
  pkg: PackageWithFile,
): Promise<Content> {
  const parsed = UpdatePackageContentSchema.safeParse({
    emailTo: pkg.emailTo ?? "",
    emailSubject: pkg.emailSubject,
    emailBody: pkg.emailBody,
  });
  if (!parsed.success || !parsed.data.emailTo) {
    throw new CockpitError("VALIDATION");
  }
  if (pkg.cvPdfStale) throw new CockpitError("VALIDATION");
  const filePath = pkg.cvFile
    ? await resolveCockpitFile(userId, pkg.cvFile)
    : null;
  if (!filePath) throw new CockpitError("FILE_NOT_FOUND");
  return {
    to: parsed.data.emailTo,
    subject: pkg.emailSubject,
    body: pkg.emailBody,
    filePath,
    fileName: sanitizePdfName(pkg.cvFile?.fileName ?? ""),
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

// Job -> applied, same update as markPackageAppliedManually (SPEC §6.4 step 6).
async function markJobApplied(
  tx: Db,
  userId: string,
  jobId: string,
  now: Date,
): Promise<void> {
  const applied = await tx.jobStatus.findUnique({ where: { value: "applied" } });
  if (!applied) throw new CockpitError("INTERNAL");
  await tx.job.updateMany({
    where: { id: jobId, userId },
    data: { statusId: applied.id, applied: true, appliedDate: now },
  });
}

// Clears the lock after a definitive failure. If this write itself fails the
// lock stays and the stale-lock rule (60 s) opens the recovery panel.
async function releaseQuietly(userId: string, id: string): Promise<void> {
  try {
    await prisma.applicationPackage.updateMany({
      where: { id, userId, status: "approved", sendStartedAt: { not: null } },
      data: { sendStartedAt: null, sendOutcome: null },
    });
  } catch {
    log.error("cockpit: could not release send lock", { packageId: id });
  }
}

async function markUnknownQuietly(userId: string, id: string): Promise<void> {
  try {
    await prisma.applicationPackage.updateMany({
      where: { id, userId, status: "approved", sendStartedAt: { not: null } },
      data: { sendOutcome: "unknown" },
    });
  } catch {
    log.error("cockpit: could not set sendOutcome", { packageId: id });
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
  // Only the active version may be sent.
  const active = await prisma.applicationPackage.findFirst({
    where: { jobId: pkg.jobId, userId, status: { not: "superseded" } },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  if (active?.id !== pkg.id) throw new CockpitError("CONFLICT");
  await checkContent(userId, pkg);
  // Rendered here, before the lock: a long letter takes seconds, and the lock
  // window (STALE_LOCK_MS) is sized for the Gmail calls. The lock is tied to
  // updatedAt and edits are refused while it is held, so the text cannot change.
  const letterReady = await buildLetterAttachment(pkg, pkg.cvFile?.fileName ?? "");

  const account = await prisma.gmailAccount.findUnique({
    where: { userId },
    select: { email: true, encryptedRefreshToken: true, iv: true },
  });
  const allowed = process.env.COCKPIT_GMAIL_ALLOWED_ADDRESS?.trim().toLowerCase();
  // Not connected, allow-list unset or different address: nothing is sent.
  if (!account || !allowed || account.email.trim().toLowerCase() !== allowed) {
    throw new CockpitError("GMAIL_RECONNECT_REQUIRED");
  }

  // ---- Step 2: lock (conditional, includes the updatedAt the user saw) ---
  const lock = await prisma.applicationPackage.updateMany({
    where: {
      id: packageId,
      userId,
      status: "approved",
      sendStartedAt: null,
      updatedAt: expectedUpdatedAt,
    },
    data: { sendStartedAt: new Date() },
  });
  if (lock.count === 0) throw new CockpitError("CONFLICT");

  // ---- Steps 3-4: re-read, then everything up to the Gmail call. Any
  // failure here means nothing was sent: definitive, release the lock. ------
  let raw: string;
  let content: Content;
  let accessToken: string;
  try {
    const fresh = await withFile(userId, packageId);
    if (!fresh || fresh.status !== "approved" || fresh.sendStartedAt === null) {
      throw new CockpitError("CONFLICT");
    }
    content = await checkContent(userId, fresh);
    const attachment = {
      fileName: content.fileName,
      content: await fs.readFile(content.filePath),
    };
    // The cover letter PDF made before the lock; made again only if the row
    // changed in between (it cannot, by the updatedAt condition: defensive).
    const letter =
      fresh.letterMd === pkg.letterMd && fresh.cvJson === pkg.cvJson
        ? letterReady
        : await buildLetterAttachment(fresh, fresh.cvFile?.fileName ?? "");
    const extraAttachments = letter ? [letter] : [];
    raw = encodeRaw(
      buildMimeMessage({
        from: account.email,
        to: content.to,
        subject: content.subject,
        bodyText: content.body,
        attachment,
        extraAttachments,
      }),
    );
    let refreshToken: string;
    try {
      refreshToken = decrypt(account.encryptedRefreshToken, account.iv);
    } catch {
      throw new CockpitError("GMAIL_RECONNECT_REQUIRED");
    }
    accessToken = await gmail.getAccessToken(refreshToken);
  } catch (e) {
    await releaseQuietly(userId, packageId);
    if (e instanceof CockpitError) throw e;
    log.error("cockpit: send failed before Gmail call", { packageId });
    throw new CockpitError("INTERNAL");
  }

  // ---- Step 5: the Gmail call --------------------------------------------
  let sent: { id: string; threadId: string };
  try {
    sent = await gmail.sendRaw(accessToken, raw);
  } catch (e) {
    if (e instanceof CockpitError && e.definitive === true) {
      await releaseQuietly(userId, packageId); // 5a: nothing was sent
      throw e;
    }
    // 5b: the message may have gone out. Keep the lock, flag the outcome.
    await markUnknownQuietly(userId, packageId);
    log.warn("cockpit: send outcome unknown", { packageId });
    throw new CockpitError("SEND_OUTCOME_UNKNOWN");
  }

  // ---- Step 6: success, one transaction -----------------------------------
  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      const res = await tx.applicationPackage.updateMany({
        where: {
          id: packageId,
          userId,
          status: "approved",
          sendStartedAt: { not: null },
        },
        data: {
          status: "sent",
          sentAt: now,
          sentVia: "gmail",
          sendOutcome: null,
        },
      });
      if (res.count === 0) {
        log.error("cockpit: package not in the locked approved state after send", {
          packageId,
        });
      }
      await tx.sentEmail.create({
        data: {
          userId,
          packageId,
          fromAddress: account.email,
          toAddress: content.to,
          gmailMessageId: sent.id,
          threadId: sent.threadId,
          sentAt: now,
        },
      });
      await markJobApplied(tx, userId, pkg.jobId, now);
    });
  } catch {
    // The email is out but we could not record it. The lock stays (no second
    // send possible); the panel lets the user mark it as sent (SPEC §6.4).
    log.error("cockpit: could not record a sent email", {
      packageId,
      gmailMessageId: sent.id,
    });
    await markUnknownQuietly(userId, packageId);
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
      select: { jobId: true },
    });
    if (!pkg) throw new CockpitError("NOT_FOUND");
    await markJobApplied(tx, userId, pkg.jobId, now);
  });
  return { id, sentAt: now };
}

// The email is not in Gmail: clear the lock, the package is approved again.
export async function releaseSendLock(
  userId: string,
  id: string,
): Promise<{ id: string }> {
  const res = await prisma.applicationPackage.updateMany({
    where: recoverable(userId, id),
    data: { sendStartedAt: null, sendOutcome: null },
  });
  if (res.count === 0) throw await notRecoverable(userId, id);
  return { id };
}
