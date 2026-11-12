// Pure follow-up helpers shared by the send service and the review UI (D-042).
// No server imports: client components use them too.

// The shared subject limit (schemas.ts, cockpit_limits.json).
const SUBJECT_MAX = 300;
const RE_PREFIX = /^\s*re\s*:/i;

// A follow-up subject always starts with "Re: " (D-034 g): Gmail threads by
// thread id and subject when there is no stored Message-ID. The Send dialog
// shows the result of this function and the send service sends exactly it.
export function replySubject(subject: string | null | undefined): string {
  const base = subject ?? "";
  const withRe = RE_PREFIX.test(base) ? base : `Re: ${base}`;
  if (withRe.length <= SUBJECT_MAX) return withRe;
  const out = withRe.slice(0, SUBJECT_MAX);
  const last = out.charCodeAt(out.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out;
}

// A Gmail thread id is an opaque id (hex in practice). Anything else is not
// passed to Gmail nor put in a URL.
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidThreadId(v: string | null | undefined): v is string {
  return typeof v === "string" && THREAD_ID_PATTERN.test(v);
}

// "Open thread in Gmail" (plan 3.6). A thread id is not a credential; tokens
// never reach the client. Null when there is no usable id.
export function gmailThreadUrl(threadId: string | null | undefined): string | null {
  return isValidThreadId(threadId)
    ? `https://mail.google.com/mail/u/0/#all/${threadId}`
    : null;
}

export function followUpLabel(step: number | null | undefined): string {
  return step === 1 || step === 2 ? `Follow-up ${step}` : "Follow-up";
}

// The follow-up state of a job for the UI, built on the server from
// computeFollowUpDue and the JobFollowUp row (dates as Date objects).
export type FollowUpSummary = {
  jobId: string;
  outcome: string | null;
  stopped: boolean;
  // From computeFollowUpDue: null when the job is not eligible.
  step: 1 | 2 | null;
  status: "scheduled" | "due" | "snoozed" | "expired" | null;
  reason: string | null;
  dueAt: Date | null;
  snoozedUntil: Date | null;
  threadUrl: string | null;
  applicationSentAt: Date | null;
  applicationPackageId: string | null;
};

// Skip only works on a due or snoozed step (D-034 a); snooze the same.
export function canSkipOrSnooze(s: Pick<FollowUpSummary, "status">): boolean {
  return s.status === "due" || s.status === "snoozed";
}

const fmtDay = (d: Date) =>
  new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

// One plain sentence about where the follow-ups of a job stand.
export function followUpStatusText(s: FollowUpSummary): string {
  if (s.outcome === "replied") return "You got a reply: no more follow-ups.";
  if (s.outcome === "interview") return "Interview recorded: no more follow-ups.";
  if (s.outcome === "rejected" || s.outcome === "closed") return "Rejected or closed: no more follow-ups.";
  if (s.stopped) return "Follow-ups stopped.";
  switch (s.reason) {
    case "complete":
      return "Both follow-ups are done.";
    case "job_not_applied":
      return "No follow-ups: the job status is not Applied.";
    case "no_recipient":
      return "No follow-ups: this application was not sent by email.";
    case "no_sent_application":
      return "No follow-ups: the application is not sent.";
  }
  const label = followUpLabel(s.step);
  switch (s.status) {
    case "scheduled":
      return s.dueAt ? `${label} is due on ${fmtDay(s.dueAt)}.` : `${label} is scheduled.`;
    case "due":
      return `${label} is due.`;
    case "snoozed":
      return s.snoozedUntil
        ? `${label} is snoozed until ${fmtDay(s.snoozedUntil)}.`
        : `${label} is snoozed.`;
    case "expired":
      return `${label} is no longer suggested (older than the follow-up window).`;
  }
  return "";
}

export { fmtDay as formatFollowUpDay };
