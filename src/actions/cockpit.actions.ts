"use server";

import fs from "fs/promises";
import prisma from "@/lib/db";
import { isGmailSendAllowed } from "@/lib/cockpit/config";
import { mutate, reviewPaths, run } from "@/lib/cockpit/actionRunner";
import { CockpitError } from "@/lib/cockpit/errors";
import { toPackageView, toSendHistoryView } from "@/lib/cockpit/packageView";
import { letterAttachmentName, sanitizePdfName } from "@/lib/cockpit/attachments";
import { resolveCockpitFile } from "@/lib/cockpit/files";
import {
  QUEUE_TAB_STATUSES,
  approvePackage as approvePackageSvc,
  getPackageWithJob,
  listJobVersions,
  listPackagesByTab,
  listSendHistory,
  markPackageAppliedManually as markPackageAppliedManuallySvc,
  rejectPackage as rejectPackageSvc,
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

// Explicit select: the refresh token and iv never leave the server (AC-43).
function findGmailAccount(userId: string) {
  return prisma.gmailAccount.findUnique({
    where: { userId },
    select: { email: true, scopes: true },
  });
}

export async function approvePackage(id: string) {
  return mutate(reviewPaths(id), (userId) => approvePackageSvc(userId, id));
}

export async function unapprovePackage(id: string) {
  return mutate(reviewPaths(id), (userId) => unapprovePackageSvc(userId, id));
}

export async function rejectPackage(id: string, reason: string) {
  return mutate(reviewPaths(id), (userId) => rejectPackageSvc(userId, id, reason));
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
      findGmailAccount(userId),
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
      listJobVersions(userId, row.jobId),
      findGmailAccount(userId),
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
    // versions are newest first: the first non-superseded one is the active one.
    const activeId = versions.find((v) => v.status !== "superseded")?.id ?? null;
    return {
      package: toPackageView(row),
      versions,
      sendHistory: toSendHistoryView(history),
      activePackageId: activeId,
      isActive: activeId === row.id,
      attachment,
      // The cover letter is attached as a PDF made from the letter text (D-015).
      letterAttachment: row.letterMd?.trim()
        ? { fileName: letterAttachmentName(cvFile?.fileName) }
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
    };
  });
}
