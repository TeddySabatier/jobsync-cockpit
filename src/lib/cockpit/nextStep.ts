// What the primary button of the action bar does at each stage (D-041). Pure:
// the component renders it, the tests pin the mapping. One primary per stage;
// every other action lives in the secondary row / menu.

export type NextStepInput = {
  status: string;
  // The send lock is set: the send-outcome panel owns the bar.
  sendStarted: boolean;
  // The package has a recipient address (false = apply via link).
  hasRecipient: boolean;
  // Why Send is not possible right now (see sendBlockedReason), or null.
  blockedReason: string | null;
  hasJobUrl: boolean;
};

export type NextStep =
  // Pending email application, Send possible: Approve, then open the dialog.
  | { kind: "approve_and_send" }
  // Pending email application, Send not possible yet: Approve only, with the reason.
  | { kind: "approve_only"; reason: string }
  // Approved email application.
  | { kind: "send" }
  | { kind: "send_blocked"; reason: string }
  // No recipient: open the posting, then "I applied". Valid from pending: no Approve.
  | { kind: "link_apply"; hasJobUrl: boolean }
  // Changes requested: the bot has to run; the owner copies the prompt.
  | { kind: "handle_changes" }
  // Rejected: bring it back.
  | { kind: "reopen" }
  // Sent: nothing left to do here, go to the next one.
  | { kind: "next" }
  // Locked by an unresolved send, or a version that is not actionable.
  | { kind: "locked" }
  | { kind: "none" };

export function nextStep(i: NextStepInput): NextStep {
  switch (i.status) {
    case "changes_requested":
      return { kind: "handle_changes" };
    case "rejected":
      return { kind: "reopen" };
    case "sent":
      return { kind: "next" };
    case "pending":
    case "approved":
      break;
    default:
      return { kind: "none" };
  }
  if (i.sendStarted) return { kind: "locked" };
  if (!i.hasRecipient) return { kind: "link_apply", hasJobUrl: i.hasJobUrl };
  if (i.status === "approved") {
    return i.blockedReason
      ? { kind: "send_blocked", reason: i.blockedReason }
      : { kind: "send" };
  }
  return i.blockedReason
    ? { kind: "approve_only", reason: i.blockedReason }
    : { kind: "approve_and_send" };
}
