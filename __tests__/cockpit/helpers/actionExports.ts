// AC-44: a "use server" file may only export the intended async functions.
// Shared with the null-user specs so each checks the exact export names.
export const ALLOWED: Record<string, string[]> = {
  "cockpit.actions.ts": [
    "approvePackage",
    "unapprovePackage",
    "rejectPackage",
    "requestPackageChanges",
    "updatePackageContent",
    "markPackageAppliedManually",
    "getReviewQueue",
    "getPackageDetail",
    "getAdjacentPackageIds",
    "reopenPackage",
    "getTodoCount",
  ],
  "cockpitGmail.actions.ts": ["getGmailSettings", "disconnectGmail"],
  "cockpitSend.actions.ts": [
    "sendPackage",
    "markSendUnknownAsSent",
    "releaseSendLock",
  ],
};
