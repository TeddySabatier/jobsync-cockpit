"use server";

import fs from "fs/promises";
import { revalidatePath } from "next/cache";
import prisma from "@/lib/db";
import { requireUser } from "./shared";
import { isCockpitEnabled } from "@/lib/cockpit/config";
import {
  CockpitError,
  toActionResult,
  type CockpitResult,
} from "@/lib/cockpit/errors";
import { sanitizePdfName } from "@/lib/cockpit/attachments";
import { letterPdfName } from "@/lib/cockpit/letterName";
import { resolveCockpitFile } from "@/lib/cockpit/files";
import {
  QUEUE_TAB_STATUSES,
  approvePackage as approvePackageSvc,
  getPackageWithJob,
  listJobVersions,
  listPackagesByTab,
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
// helpers below are module-private. Order in every body (P6): requireUser()
// inside the try, then the flag, then the work. A throw becomes a failure
// result and no DB access happens before the user is known.

async function run<T>(
  fn: (userId: string) => Promise<T>,
): Promise<CockpitResult<T>> {
  try {
    const user = await requireUser();
    if (!isCockpitEnabled()) throw new CockpitError("COCKPIT_DISABLED");
    return { success: true, data: await fn(user.id) };
  } catch (e) {
    return toActionResult(e);
  }
}

function revalidate(id: string) {
  revalidatePath("/dashboard/review");
  revalidatePath(`/dashboard/review/${id}`);
}

// Runs a mutation, then revalidates only on success.
async function mutate<T>(id: string, fn: (userId: string) => Promise<T>) {
  const result = await run(fn);
  if (result.success) revalidate(id);
  return result;
}

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
  return mutate(id, (userId) => approvePackageSvc(userId, id));
}

export async function unapprovePackage(id: string) {
  return mutate(id, (userId) => unapprovePackageSvc(userId, id));
}

export async function rejectPackage(id: string, reason: string) {
  return mutate(id, (userId) => rejectPackageSvc(userId, id, reason));
}

export async function requestPackageChanges(id: string, instruction: string) {
  return mutate(id, (userId) =>
    requestPackageChangesSvc(userId, id, instruction),
  );
}

export async function updatePackageContent(
  id: string,
  patch: UpdatePackageContentInput,
) {
  return mutate(id, (userId) => updatePackageContentSvc(userId, id, patch));
}

export async function markPackageAppliedManually(id: string) {
  return mutate(id, (userId) => markPackageAppliedManuallySvc(userId, id));
}

// Queue rows plus what the readiness chips and the Gmail callout need (§5.2).
export async function getReviewQueue(tab: QueueTab) {
  return run(async (userId) => {
    const rows = await listPackagesByTab(userId, parseTab(tab));
    const gmail = await findGmailAccount(userId);
    const approvedWithEmail = await prisma.applicationPackage.count({
      where: {
        userId,
        status: "approved",
        AND: [{ emailTo: { not: null } }, { emailTo: { not: "" } }],
      },
    });
    return {
      rows,
      gmail: gmail ? { email: gmail.email } : null,
      gmailCalloutNeeded: !gmail && approvedWithEmail > 0,
    };
  });
}

export async function getPackageDetail(id: string) {
  return run(async (userId) => {
    const { cvFile, ...pkg } = await getPackageWithJob(userId, id);
    const [versions, gmail] = await Promise.all([
      listJobVersions(userId, pkg.jobId),
      findGmailAccount(userId),
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
      package: pkg,
      versions,
      activePackageId: activeId,
      isActive: activeId === pkg.id,
      attachment,
      // The cover letter is attached as a PDF made from the letter text (D-015).
      letterAttachment: pkg.letterMd?.trim()
        ? { fileName: sanitizePdfName(letterPdfName(cvFile?.fileName)) }
        : null,
      gmail: gmail ? { email: gmail.email, scopes: gmail.scopes } : null,
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
