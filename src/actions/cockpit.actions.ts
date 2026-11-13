"use server";

import fs from "fs/promises";
import prisma from "@/lib/db";
import { isGmailSendAllowed } from "@/lib/cockpit/config";
import { mutate, reviewPaths, run } from "@/lib/cockpit/actionRunner";
import { CockpitError } from "@/lib/cockpit/errors";
import { toPackageView, toSendHistoryView } from "@/lib/cockpit/packageView";
import { letterPdfName, sanitizePdfName } from "@/lib/cockpit/letterName";
import { resolveCockpitFile } from "@/lib/cockpit/files";
import { pickActive, type PackageKind } from "@/lib/cockpit/activePackage";
import { findGmailPublic } from "@/lib/cockpit/connectedAccount";
import {
  QUEUE_TAB_STATUSES,
  approvePackage as approvePackageSvc,
  countPackagesByTab,
  getPackageWithJob,
  listJobVersions,
  listPackagesByTab,
  listSendHistory,
  markPackageAppliedManually as markPackageAppliedManuallySvc,
  countTodo,
  rejectPackage as rejectPackageSvc,
  reopenPackage as reopenPackageSvc,
  requestPackageChanges as requestPackageChangesSvc,
  unapprovePackage as unapprovePackageSvc,
  updatePackageContent as updatePackageContentSvc,
  type QueueTab,
} from "@/lib/cockpit/packages";
import type { UpdatePackageContentInput } from "@/lib/cockpit/schemas";
import { followUpStepOf, getFollowUpSummary } from "@/lib/cockpit/followUps";
import { countDueFollowUps } from "@/lib/cockpit/followUpMcp";
import type { FollowUpSummary } from "@/lib/cockpit/followUpView";

// Review actions (cockpit/SPEC.md §6.1). Every export of a "use server" file is
// a public endpoint, so only the intended async actions are exported; the
// helpers below are module-private. run/mutate (src/lib/cockpit/actionRunner.ts)
// do requireUser(), then the flag, then the work (P6).

function parseTab(tab: unknown): QueueTab {
  if (
    typeof tab !== "string" ||
    !(Object.keys(QUEUE_TAB_STATUSES) as string[]).includes(tab)
  ) {
    throw new CockpitError("VALIDATION");
  }
  return tab as QueueTab;
}

export async function approvePackage(id: string) {
  return mutate(reviewPaths(id), (userId) => approvePackageSvc(userId, id));
}

export async function unapprovePackage(id: string) {
  return mutate(reviewPaths(id), (userId) => unapprovePackageSvc(userId, id));
}

// The reason is optional (D-041).
export async function rejectPackage(id: string, reason?: string) {
  return mutate(reviewPaths(id), (userId) => rejectPackageSvc(userId, id, reason));
}

// Undo a reject: back to pending (D-041).
export async function reopenPackage(id: string) {
  return mutate(reviewPaths(id, { jobs: true }), (userId) => reopenPackageSvc(userId, id));
}

export async function requestPackageChanges(id: string, instruction: string) {
  return mutate(reviewPaths(id), (userId) =>
    requestPackageChangesSvc(userId, id, instruction),
  );
}

export async function updatePackageContent(
  id: string,
  patch: UpdatePackageContentInput,
) {
  return mutate(reviewPaths(id), (userId) => updatePackageContentSvc(userId, id, patch));
}

export async function markPackageAppliedManually(id: string) {
  return mutate(reviewPaths(id, { jobs: true }), (userId) =>
    markPackageAppliedManuallySvc(userId, id),
  );
}

// Queue rows plus what the readiness chips and the Gmail callout need (§5.2).
export async function getReviewQueue(tab: QueueTab) {
  return run(async (userId) => {
    const parsedTab = parseTab(tab);
    const now = new Date();
    const [rawRows, gmail, approvedWithEmail, counts, dueFollowUps] = await Promise.all([
      // Both kinds (D-042): a follow-up draft is a To do row with its chip.
      listPackagesByTab(userId, parsedTab, "all", now),
      findGmailPublic(userId),
      prisma.applicationPackage.count({
        where: {
          userId,
          status: "approved",
          AND: [{ emailTo: { not: null } }, { emailTo: { not: "" } }],
        },
      }),
      countPackagesByTab(userId, "all", now),
      countDueFollowUps(userId, now),
    ]);
    // Follow-up rows carry their step and the job's follow-up state (for the
    // row menu). One summary per job, a handful of rows at most.
    const summaries = new Map<string, Awaited<ReturnType<typeof getFollowUpSummary>>>();
    for (const r of rawRows) {
      if (r.kind === "follow_up" && !summaries.has(r.jobId)) {
        summaries.set(r.jobId, await getFollowUpSummary(userId, r.jobId, now));
      }
    }
    const rows = await Promise.all(
      rawRows.map(async ({ replyToPackageId: _r, sentAt, ...r }) => {
        const extra: { followUpStep: 1 | 2 | null; followUp: FollowUpSummary | null } =
          r.kind !== "follow_up"
            ? { followUpStep: null, followUp: null }
            : {
                followUpStep: await followUpStepOf(
                  userId,
                  { jobId: r.jobId, status: r.status, sentAt },
                  summaries.get(r.jobId) ?? null,
                ),
                followUp: summaries.get(r.jobId) ?? null,
              };
        return { ...r, ...extra };
      }),
    );
    return {
      rows,
      counts,
      dueFollowUps,
      gmail: gmail ? { email: gmail.email } : null,
      gmailCalloutNeeded: !gmail && approvedWithEmail > 0,
    };
  });
}

export async function getPackageDetail(id: string) {
  return run(async (userId) => {
    const { cvFile, ...row } = await getPackageWithJob(userId, id);
    const [versions, gmail, history] = await Promise.all([
      // The versions of this package's own kind: they are numbered per (job, kind).
      listJobVersions(userId, row.jobId, row.kind as PackageKind),
      findGmailPublic(userId),
      listSendHistory(userId, row.id),
    ]);
    // Attachment name and size come from disk, through the confinement helper.
    // The stored filePath itself is not sent to the client.
    let attachment: { fileName: string; size: number } | null = null;
    if (cvFile) {
      const real = await resolveCockpitFile(userId, cvFile);
      if (real) {
        try {
          attachment = {
            fileName: sanitizePdfName(cvFile.fileName),
            size: (await fs.stat(real)).size,
          };
        } catch {
          attachment = null;
        }
      }
    }
    const activeId = pickActive(versions)?.id ?? null;
    const isFollowUp = row.kind === "follow_up";
    // Follow-up state (D-042): on a follow-up, and on a sent application (the
    // outcome toggles and "Open thread in Gmail" live there).
    const followUp =
      isFollowUp || row.status === "sent"
        ? await getFollowUpSummary(userId, row.jobId)
        : null;
    const followUpStep = isFollowUp
      ? await followUpStepOf(userId, { jobId: row.jobId, status: row.status, sentAt: row.sentAt }, followUp)
      : null;
    // The application a follow-up replies to: its date and subject for the
    // banner, its id for the link. Scoped to the user and the job.
    const replyTo =
      isFollowUp && row.replyToPackageId
        ? await prisma.applicationPackage.findFirst({
            where: { id: row.replyToPackageId, userId, jobId: row.jobId, kind: "application" },
            select: { id: true, sentAt: true, emailSubject: true },
          })
        : null;
    return {
      package: toPackageView(row),
      kind: (isFollowUp ? "follow_up" : "application") as PackageKind,
      followUp,
      followUpStep,
      replyTo,
      versions,
      sendHistory: toSendHistoryView(history),
      activePackageId: activeId,
      isActive: activeId === row.id,
      attachment: isFollowUp ? null : attachment,
      // The cover letter is attached as a PDF made from the letter text (D-015).
      // Never on a follow-up (D-042).
      letterAttachment:
        !isFollowUp && row.letterMd?.trim()
          ? { fileName: letterPdfName(cvFile?.fileName) }
          : null,
      gmail: gmail ? { email: gmail.email, scopes: gmail.scopes } : null,
      // The connected address matches the send allow-list (Send is possible).
      // Read by ActionBar (sendBlockedReason): a dedicated reason, not a Send that fails.
      gmailSendAllowed: isGmailSendAllowed(gmail?.email),
    };
  });
}

// j / k in the todo queue (§5.3): ids around `id` in queue order. Both null
// when the package is not in the todo tab.
export async function getAdjacentPackageIds(id: string) {
  return run(async (userId) => {
    // The To do queue as the owner sees it: both kinds (D-042).
    const rows = await listPackagesByTab(userId, "todo", "all");
    const i = rows.findIndex((r) => r.id === id);
    return {
      previousId: i > 0 ? rows[i - 1].id : null,
      nextId: i >= 0 && i < rows.length - 1 ? rows[i + 1].id : null,
      // Other To do items besides this one (auto-advance toast).
      todoLeft: i >= 0 ? rows.length - 1 : rows.length,
    };
  });
}

// Sidebar badge and focus refresh: To do items (applications and follow-up
// drafts) plus follow-ups that are due and not drafted yet (D-042). Cheap; an
// error or a disabled cockpit is a quiet failure result.
export async function getTodoCount() {
  return run(async (userId) => {
    const [todo, due] = await Promise.all([countTodo(userId), countDueFollowUps(userId)]);
    return todo + due;
  });
}
