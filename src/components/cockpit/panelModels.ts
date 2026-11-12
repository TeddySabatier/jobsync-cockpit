// Pure view models for the detail panels (D-040), kept out of the components
// so they can be unit tested without rendering.

export type HistoryTone = "ok" | "fail" | "unknown" | "neutral";

export type AttemptView = {
  tone: HistoryTone;
  badge: string;
  // Plain sentence for what happened; never the raw outcome string.
  sentence: string;
};

const ATTEMPTS: Record<string, AttemptView> = {
  sent: { tone: "ok", badge: "Sent", sentence: "Gmail accepted the message" },
  failed: {
    tone: "fail",
    badge: "Not sent",
    sentence: "Gmail or the app refused before the message left",
  },
  ambiguous: {
    tone: "unknown",
    badge: "Unknown",
    sentence: "Result unknown: the message may or may not have gone out",
  },
  record_failed: {
    tone: "unknown",
    badge: "Check Gmail",
    sentence:
      "Gmail accepted the message, but the app could not record it. Sending is blocked until you check your Gmail Sent folder",
  },
  late_recorded: {
    tone: "ok",
    badge: "Sent (late)",
    sentence:
      "Gmail accepted the message after this application was no longer waiting to be sent. It was recorded as sent",
  },
  lock_lost: {
    tone: "unknown",
    badge: "Check Gmail",
    sentence:
      "Gmail accepted the message after you had released the block on sending. Check your Gmail Sent folder before sending again",
  },
  marked_sent: {
    tone: "ok",
    badge: "Marked sent",
    sentence: "You marked it as sent (manual)",
  },
  lock_released: {
    tone: "neutral",
    badge: "Unblocked",
    sentence: "You released the block on sending (the email was not in Gmail)",
  },
};

const UNRECOGNIZED: AttemptView = {
  tone: "unknown",
  badge: "Unrecognized",
  sentence: "Unrecognized entry",
};

export function attemptView(outcome: string): AttemptView {
  return Object.prototype.hasOwnProperty.call(ATTEMPTS, outcome)
    ? ATTEMPTS[outcome]
    : UNRECOGNIZED;
}

export const HISTORY_COLLAPSE_AFTER = 3;

// Oldest first in, oldest first out: the newest `limit` rows stay visible and
// the rest are the collapsed earlier attempts.
export function splitHistory<T>(
  rows: T[],
  expanded: boolean,
  limit = HISTORY_COLLAPSE_AFTER,
): { hidden: number; visible: T[] } {
  // One hidden row is not worth a button: limit + 1 rows show in full.
  if (expanded || rows.length <= limit + 1) return { hidden: 0, visible: rows };
  return { hidden: rows.length - limit, visible: rows.slice(rows.length - limit) };
}

// "must_haves" and "mustHaves" -> "Must haves".
export function humanizeKey(key: string): string {
  const text = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : key;
}

const FIT_LABELS: Record<string, string> = {
  summary: "Summary",
  score: "Match score",
  fitscore: "Match score",
  strengths: "Strengths",
  gaps: "Gaps",
  weaknesses: "Gaps",
};

export function fitLabel(key: string): string {
  return FIT_LABELS[key.toLowerCase()] ?? humanizeKey(key);
}

export type FitKind = "score" | "strengths" | "gaps" | "other";

export function fitKind(key: string, value: unknown): FitKind {
  const k = key.toLowerCase();
  if ((k === "score" || k === "fitscore") && fitScore(value) !== null) return "score";
  const list = Array.isArray(value) && value.every((v) => typeof v === "string");
  if (list && k === "strengths") return "strengths";
  if (list && (k === "gaps" || k === "weaknesses")) return "gaps";
  return "other";
}

// A numeric score in 0..100 (a numeric string counts); anything else is null
// and falls back to plain text.
export function fitScore(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}
