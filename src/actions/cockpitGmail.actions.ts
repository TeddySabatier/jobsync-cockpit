"use server";

import prisma from "@/lib/db";
import { mutate, run } from "@/lib/cockpit/actionRunner";
import type { CockpitResult } from "@/lib/cockpit/errors";
import { revokeToken } from "@/lib/cockpit/gmail/client";
import { missingGmailEnv } from "@/lib/cockpit/gmail/oauth";
import { decrypt } from "@/lib/encryption";

// Gmail settings actions (cockpit/SPEC.md §5.5, §6.2). requireUser() first,
// then the flag, inside the try (P5, P6): see actionRunner.ts.

export async function getGmailSettings(): Promise<
  CockpitResult<{
    missingEnv: string[];
    account: { email: string; scopes: string } | null;
  }>
> {
  return run(async (userId) => {
    // Explicit select: the token and iv never reach a page prop (AC-43).
    const account = await prisma.gmailAccount.findUnique({
      where: { userId },
      select: { email: true, scopes: true },
    });
    return { missingEnv: missingGmailEnv(), account };
  });
}

export async function disconnectGmail(): Promise<
  CockpitResult<{ disconnected: true }>
> {
  return mutate(
    ["/dashboard/review", "/dashboard/review/settings"],
    async (userId) => {
      const account = await prisma.gmailAccount.findUnique({
        where: { userId },
        select: { encryptedRefreshToken: true, iv: true },
      });
      if (account) {
        try {
          await revokeToken(decrypt(account.encryptedRefreshToken, account.iv));
        } catch {
          // Best effort: a lost key or an already-dead token must not block
          // the delete.
        }
      }
      await prisma.gmailAccount.deleteMany({ where: { userId } });
      return { disconnected: true as const };
    },
  );
}
