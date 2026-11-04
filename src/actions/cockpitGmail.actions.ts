"use server";

import { revalidatePath } from "next/cache";
import prisma from "@/lib/db";
import { requireUser } from "@/actions/shared";
import { isCockpitEnabled } from "@/lib/cockpit/config";
import {
  CockpitError,
  toActionResult,
  type CockpitResult,
} from "@/lib/cockpit/errors";
import { revokeToken } from "@/lib/cockpit/gmail/client";
import { missingGmailEnv } from "@/lib/cockpit/gmail/oauth";
import { decrypt } from "@/lib/encryption";

// Gmail settings actions (cockpit/SPEC.md §5.5, §6.2). requireUser() first,
// then the flag, inside the try (P5, P6).

export async function getGmailSettings(): Promise<
  CockpitResult<{
    missingEnv: string[];
    account: { email: string; scopes: string } | null;
  }>
> {
  try {
    const user = await requireUser();
    if (!isCockpitEnabled()) throw new CockpitError("COCKPIT_DISABLED");
    // Explicit select: the token and iv never reach a page prop (AC-43).
    const account = await prisma.gmailAccount.findUnique({
      where: { userId: user.id },
      select: { email: true, scopes: true },
    });
    return { success: true, data: { missingEnv: missingGmailEnv(), account } };
  } catch (e) {
    return toActionResult(e);
  }
}

export async function disconnectGmail(): Promise<
  CockpitResult<{ disconnected: true }>
> {
  try {
    const user = await requireUser();
    if (!isCockpitEnabled()) throw new CockpitError("COCKPIT_DISABLED");

    const account = await prisma.gmailAccount.findUnique({
      where: { userId: user.id },
      select: { encryptedRefreshToken: true, iv: true },
    });
    if (account) {
      try {
        await revokeToken(decrypt(account.encryptedRefreshToken, account.iv));
      } catch {
        // Best effort (a lost key or an already-dead token must not block the
        // delete); typed Google errors were logged with code and status only.
      }
    }
    await prisma.gmailAccount.deleteMany({ where: { userId: user.id } });

    revalidatePath("/dashboard/review");
    revalidatePath("/dashboard/review/settings");
    return { success: true, data: { disconnected: true } };
  } catch (e) {
    return toActionResult(e);
  }
}
