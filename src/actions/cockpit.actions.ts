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
    const [rows, gmail, approvedWithEmail] = await Promise.all([
      listPackagesByTab(userId, parsedTab),
      findGmailPublic(userId),
      prisma.applicationPackage.count({
        where: {
          userId,
          status: "approved",
          AND: [{ emailTo: { not: null } }, { emailTo: { not: "" } }],
        },
      }),
    ]);
    return {
      rows,
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
    return {
      package: toPackageView(row),
      versions,
      sendHistory: toSendHistoryView(history),
      activePackageId: activeId,
      isActive: activeId === row.id,
      attachment,
      // The cover letter is attached as a PDF made from the letter text (D-015).
      letterAttachment: row.letterMd?.trim()
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
    const rows = await listPackagesByTab(userId, "todo");
    const i = rows.findIndex((r) => r.id === id);
    return {
      previousId: i > 0 ? rows[i - 1].id : null,
      nextId: i >= 0 && i < rows.length - 1 ? rows[i + 1].id : null,
      // Other To do applications besides this one (auto-advance toast).
      todoLeft: i >= 0 ? rows.length - 1 : rows.length,
    };
  });
}

// Sidebar badge and focus refresh: how many applications wait in To do. Cheap
// (one count); an error or a disabled cockpit is a quiet failure result.
export async function getTodoCount() {
  return run(async (userId) => countTodo(userId));
}
