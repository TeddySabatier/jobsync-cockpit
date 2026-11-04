"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "./shared";
import { isCockpitEnabled } from "@/lib/cockpit/config";
import {
  CockpitError,
  toActionResult,
  type CockpitResult,
} from "@/lib/cockpit/errors";
import { createHttpGmailClient } from "@/lib/cockpit/gmail/client";
import {
  markSendUnknownAsSent as markSendUnknownAsSentSvc,
  releaseSendLock as releaseSendLockSvc,
  sendApplicationPackage,
} from "@/lib/cockpit/send";

// Send actions (cockpit/SPEC.md §6.4). The ONLY place that reaches the send
// service, and only from a logged-in UI session: requireUser() runs first,
// inside the try, then the flag (P6). Every export of a "use server" file is a
// public endpoint, so only the three intended async actions are exported.

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
  revalidatePath("/dashboard/myjobs");
}

// Revalidates after every outcome except an auth/flag failure: a failed send can
// still have changed the package (lock, outcome), and the page must show it.
async function mutate<T>(id: string, fn: (userId: string) => Promise<T>) {
  const result = await run(fn);
  if (
    result.success ||
    (result.code !== "UNAUTHENTICATED" && result.code !== "COCKPIT_DISABLED")
  ) {
    revalidate(id);
  }
  return result;
}

// `expectedUpdatedAt` is the package updatedAt the user saw in the Send dialog.
export async function sendPackage(id: string, expectedUpdatedAt: Date | string) {
  return mutate(id, async (userId) => {
    const expected = new Date(expectedUpdatedAt);
    if (Number.isNaN(expected.getTime())) throw new CockpitError("VALIDATION");
    return sendApplicationPackage(userId, id, expected, createHttpGmailClient());
  });
}

export async function markSendUnknownAsSent(id: string) {
  return mutate(id, (userId) => markSendUnknownAsSentSvc(userId, id));
}

export async function releaseSendLock(id: string) {
  return mutate(id, (userId) => releaseSendLockSvc(userId, id));
}
