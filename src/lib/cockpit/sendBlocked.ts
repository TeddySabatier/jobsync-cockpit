// Why an approved application cannot be sent yet (SPEC §5.3), in priority order.
// Shared by the action bar, the summary strip and the next-step mapping.

export type SendBlockedInput = {
  package: { cvPdfStale: boolean; cvFileId: string | null; emailTo?: string | null };
  attachment: unknown;
  gmail: unknown;
  gmailSendAllowed: boolean;
  // "follow_up" (D-042): no CV is sent, so the CV rules do not apply.
  kind?: string;
};

export function sendBlockedReason(detail: SendBlockedInput): string | null {
  const pkg = detail.package;
  if (detail.kind === "follow_up") {
    if (!pkg.emailTo?.trim()) return "This follow-up has no recipient. Use Edit to add one.";
  } else {
    if (pkg.cvPdfStale) return "The CV PDF is out of date. Ask the bot to re-render.";
    if (!pkg.cvFileId || !detail.attachment) return "No CV file is attached.";
  }
  if (!detail.gmail) return "Gmail is not connected. Connect it in settings.";
  // Send would refuse with "Reconnect Gmail" for this (D-023): say why instead.
  if (!detail.gmailSendAllowed) {
    return "Sending is only allowed from the address configured for the cockpit. Connect that address in settings.";
  }
  return null;
}
