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
  fit_score: "Match score",
  strengths: "Strengths",
  gaps: "Gaps",
  weaknesses: "Gaps",
};

export function fitLabel(key: string): string {
  return FIT_LABELS[key.toLowerCase()] ?? humanizeKey(key);
}

export type FitKind = "score" | "strengths" | "gaps" | "other";

const normKey = (key: string) => key.toLowerCase().replace(/[_\-\s]+/g, "");

const SCORE_KEYS = new Set(["score", "fitscore"]);
const MAX_KEYS = new Set(["maxscore", "scoremax", "max", "outof", "scale", "scoremaximum"]);

// The stated maximum of a fit object ({score: 8, max_score: 10}), or null.
export function fitMax(obj: Record<string, unknown>): number | null {
  for (const [k, v] of Object.entries(obj)) {
    if (!MAX_KEYS.has(normKey(k))) continue;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function fitKind(key: string, value: unknown, max: number | null = null): FitKind {
  const k = normKey(key);
  if (SCORE_KEYS.has(k) && fitScoreView(value, max) !== null) return "score";
  const list = Array.isArray(value) && value.every((v) => typeof v === "string");
  if (list && k === "strengths") return "strengths";
  if (list && (k === "gaps" || k === "weaknesses")) return "gaps";
  return "other";
}

export type FitScoreView = { percent: number; text: string };

const NUM = "(\\d+(?:\\.\\d+)?)";
const PERCENT_RE = new RegExp(`^${NUM}\\s*%$`);
const OF_RE = new RegExp(`^${NUM}\\s*(?:/|out of)\\s*${NUM}$`, "i");

// Reads a score without ever guessing a wrong scale (a near-empty meter for
// "8" on a 0..10 scale is worse than plain text):
//   87, "87", "87%"          -> 87 / 100
//   0.87                     -> 87 / 100 (a 0..1 fraction)
//   "8/10", or 8 with max 10 -> 8 / 10 (scale stated)
//   2..10 with no stated max, 1, negatives, > max, text -> null (plain text)
export function fitScoreView(value: unknown, max: number | null = null): FitScoreView | null {
  let n = NaN;
  let scale = max;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") {
    const t = value.trim();
    const pct = PERCENT_RE.exec(t);
    const of = OF_RE.exec(t);
    if (pct) {
      n = Number(pct[1]);
      scale = 100;
    } else if (of) {
      n = Number(of[1]);
      scale = Number(of[2]);
    } else n = Number(t);
  }
  if (!Number.isFinite(n) || n < 0) return null;
  if (scale !== null && scale !== undefined) {
    if (!(scale > 0) || n > scale) return null;
    return { percent: Math.round((n / scale) * 100), text: `${n} / ${scale}` };
  }
  let percent: number;
  if (n === 0) percent = 0;
  else if (n < 1) percent = Math.round(n * 100);
  else if (n > 10 && n <= 100) percent = n;
  else return null;
  return { percent, text: `${percent} / 100` };
}

// The meter percentage, or null.
export function fitScore(value: unknown, max: number | null = null): number | null {
  return fitScoreView(value, max)?.percent ?? null;
}
