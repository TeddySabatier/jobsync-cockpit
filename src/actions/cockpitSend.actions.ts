"use server";

import { mutate, reviewPaths } from "@/lib/cockpit/actionRunner";
import { CockpitError } from "@/lib/cockpit/errors";
import { createHttpGmailClient } from "@/lib/cockpit/gmail/client";
import {
  markSendUnknownAsSent as markSendUnknownAsSentSvc,
  releaseSendLock as releaseSendLockSvc,
  sendApplicationPackage,
} from "@/lib/cockpit/send";

// Send actions (cockpit/SPEC.md §6.4). The ONLY place that reaches the send
// service, and only from a logged-in UI session: mutate() runs requireUser()
// first, then the flag (P6). Every export of a "use server" file is a public
// endpoint, so only the three intended async actions are exported.
// A failed send can still have changed the package (lock, outcome), so
// mutate() revalidates on every outcome but an auth/flag failure; a send and a
// resolved lock also change the job (applied), hence /dashboard/myjobs.

// `expectedUpdatedAt` is the package updatedAt the user saw in the Send dialog.
export async function sendPackage(id: string, expectedUpdatedAt: Date | string) {
  return mutate(reviewPaths(id, { jobs: true }), async (userId) => {
    // null / a number would become epoch 0 or a valid date and fail as CONFLICT.
    if (typeof expectedUpdatedAt !== "string" && !(expectedUpdatedAt instanceof Date)) {
      throw new CockpitError("VALIDATION");
    }
    const expected = new Date(expectedUpdatedAt);
    if (Number.isNaN(expected.getTime())) throw new CockpitError("VALIDATION");
    return sendApplicationPackage(userId, id, expected, createHttpGmailClient());
  });
}

export async function markSendUnknownAsSent(id: string) {
  return mutate(reviewPaths(id, { jobs: true }), (userId) =>
    markSendUnknownAsSentSvc(userId, id),
  );
}

export async function releaseSendLock(id: string) {
  return mutate(reviewPaths(id, { jobs: true }), (userId) =>
    releaseSendLockSvc(userId, id),
  );
}
