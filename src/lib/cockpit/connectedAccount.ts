import prisma from "@/lib/db";

// The two reads of the connected Gmail account. Each has an explicit select, so
// the refresh token and iv reach only the callers that need them (AC-43): the
// settings page and the review actions use findGmailPublic, and only the
// revoke paths (disconnect, reconnect with another account) and Send use the
// token fields.

// Address and granted scopes: safe to hand to a page prop.
export function findGmailPublic(userId: string) {
  return prisma.gmailAccount.findUnique({
    where: { userId },
    select: { email: true, scopes: true },
  });
}

// The encrypted refresh token and its iv, for revoking it.
export function findGmailTokens(userId: string) {
  return prisma.gmailAccount.findUnique({
    where: { userId },
    select: { encryptedRefreshToken: true, iv: true },
  });
}
