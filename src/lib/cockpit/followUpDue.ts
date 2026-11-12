// Follow-up due calculation (cockpit/V1-FOLLOWUPS-PLAN.md section 3.1, D-031).
// Pure: no Prisma, no clock, no environment. The caller passes `now`, the
// timezone and the window, so every edge case is testable with a fixed date.
//
// A follow-up is never scheduled or stored as "due": it is derived here from
// the sent application, the sent follow-ups and the job's follow-up state.

export const FOLLOW_UP_OUTCOMES = [
  "replied",
  "interview",
  "rejected",
  "closed",
] as const;
export type FollowUpOutcome = (typeof FOLLOW_UP_OUTCOMES)[number];

// At most two follow-ups (V1 non-goal: a third).
export const MAX_FOLLOW_UP_STEPS = 2;

// Step 1 is due this many days after the application was sent, step 2 this many
// days after follow-up 1 was sent (or skipped).
export const FOLLOW_UP_STEP_DAYS = { 1: 7, 2: 14 } as const;

export const DEFAULT_FOLLOW_UP_TIMEZONE = "UTC";
export const DEFAULT_FOLLOW_UP_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type FollowUpStateInput = {
  outcome: string | null;
  stopped: boolean;
  skippedThrough: number;
  skippedAt: Date | null;
  snoozedUntil: Date | null;
};

export type DueInput = {
  now: Date;
  // Job.Status.value.
  jobStatus: string | null;
  // The sent application package (kind "application", status "sent"), or null.
  application: { sentAt: Date | null; emailTo: string | null } | null;
  // Every package of kind "follow_up" with status "sent" (also the ones marked
  // sent through the recovery panel): counted from packages, not SentEmail.
  sentFollowUps: readonly { sentAt: Date | null }[];
  // The JobFollowUp row, or null when the job has none.
  state: FollowUpStateInput | null;
  // IANA name; invalid or missing falls back to UTC.
  timezone?: string;
  // Days after the due date during which the step is still suggested.
  windowDays?: number;
};

export type IneligibleReason =
  | "no_sent_application" // nothing sent yet, or the application is not sent
  | "no_recipient" // apply-via-link: no email was sent, nothing to follow up
  | "job_not_applied" // the job status is not "applied" (moved on, or archived)
  | "outcome" // replied / interview / rejected / closed recorded
  | "stopped" // the owner stopped follow-ups
  | "complete"; // both follow-ups are sent or skipped

// scheduled: before the due date; due: suggest it now; snoozed: due date passed
// but snoozed; expired: past the window, no longer suggested.
export type DueStatus = "scheduled" | "due" | "snoozed" | "expired";

export type FollowUpDue =
  | { eligible: false; reason: IneligibleReason }
  | {
      eligible: true;
      step: 1 | 2;
      anchor: Date;
      // Start (in the timezone) of the due day, moved to a weekday.
      dueAt: Date;
      // Last instant at which the step is still suggested.
      windowEnd: Date;
      status: DueStatus;
      snoozedUntil: Date | null;
    };

export function isFollowUpDue(d: FollowUpDue): boolean {
  return d.eligible && d.status === "due";
}

// ---------------------------------------------------------------------------
// Which step is next
// ---------------------------------------------------------------------------

export type StepProgress = {
  // Steps already sent or skipped (0, 1 or 2).
  consumed: number;
  // The next step number, or null when both are done.
  step: 1 | 2 | null;
  // The date the last consumed step happened (sent, or skipped), or null.
  lastEventAt: Date | null;
};

const clampSkipped = (n: number) => Math.min(MAX_FOLLOW_UP_STEPS, Math.max(0, Math.trunc(n) || 0));

// `skippedThrough` is the number of the last skipped step and `skippedAt` when;
// sends that happened before that skip were the steps before it, so the earlier
// skips are `skippedThrough - sentBefore`. Examples: skip 1, then send = 2 steps
// done; send, then skip 2 = 2 done; skip 1, skip 2 = 2 done.
export function stepProgress(
  sentFollowUps: readonly { sentAt: Date | null }[],
  state: Pick<FollowUpStateInput, "skippedThrough" | "skippedAt"> | null,
): StepProgress {
  const sentCount = sentFollowUps.length;
  const through = state ? clampSkipped(state.skippedThrough) : 0;
  const skippedAt = through > 0 ? (state?.skippedAt ?? null) : null;

  let skips = 0;
  if (through > 0) {
    const sentBefore = skippedAt
      ? sentFollowUps.filter((s) => s.sentAt && s.sentAt.getTime() < skippedAt.getTime())
          .length
      : sentCount;
    skips = Math.max(0, through - sentBefore);
  }

  const consumed = Math.min(MAX_FOLLOW_UP_STEPS, sentCount + skips);
  const sentTimes = sentFollowUps
    .map((s) => s.sentAt?.getTime())
    .filter((t): t is number => typeof t === "number");
  const events = [...sentTimes, ...(skips > 0 && skippedAt ? [skippedAt.getTime()] : [])];
  return {
    consumed,
    step: consumed >= MAX_FOLLOW_UP_STEPS ? null : ((consumed + 1) as 1 | 2),
    lastEventAt: events.length ? new Date(Math.max(...events)) : null,
  };
}

// ---------------------------------------------------------------------------
// Calendar days in a timezone
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, f);
  }
  return f;
}

// An invalid IANA name makes Intl throw; the due date then uses UTC.
export function resolveTimezone(timezone: string | null | undefined): string {
  const tz = timezone?.trim();
  if (!tz) return DEFAULT_FOLLOW_UP_TIMEZONE;
  try {
    formatter(tz);
    return tz;
  } catch {
    return DEFAULT_FOLLOW_UP_TIMEZONE;
  }
}

type Civil = { y: number; m: number; d: number };

function wallClock(timezone: string, ms: number) {
  const out: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

// The calendar day of the instant `ms` in `timezone`.
export function civilDay(timezone: string, ms: number): Civil {
  const w = wallClock(timezone, ms);
  return { y: w.year, m: w.month, d: w.day };
}

// Wall clock minus real time, in ms, at the instant `ms`.
function offsetMs(timezone: string, ms: number): number {
  const w = wallClock(timezone, ms);
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

// The instant at which the calendar day `c` starts in `timezone`.
export function startOfCivilDay(timezone: string, c: Civil): number {
  const guess = Date.UTC(c.y, c.m - 1, c.d);
  const first = offsetMs(timezone, guess);
  const t = guess - first;
  const second = offsetMs(timezone, t);
  return second === first ? t : guess - second;
}

function addCivilDays(c: Civil, n: number): Civil {
  const d = new Date(Date.UTC(c.y, c.m - 1, c.d + n));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

// Saturday and Sunday move to the next Monday.
function nextWeekday(c: Civil): Civil {
  const dow = new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
  if (dow === 6) return addCivilDays(c, 2);
  if (dow === 0) return addCivilDays(c, 1);
  return c;
}

// ---------------------------------------------------------------------------
// The calculation
// ---------------------------------------------------------------------------

export function computeFollowUpDue(input: DueInput): FollowUpDue {
  const { application, state } = input;
  if (!application || !application.sentAt) {
    return { eligible: false, reason: "no_sent_application" };
  }
  if (!application.emailTo || !application.emailTo.trim()) {
    return { eligible: false, reason: "no_recipient" };
  }
  if (input.jobStatus !== "applied") {
    return { eligible: false, reason: "job_not_applied" };
  }
  if (state?.outcome) return { eligible: false, reason: "outcome" };
  if (state?.stopped) return { eligible: false, reason: "stopped" };

  const progress = stepProgress(input.sentFollowUps, state);
  if (progress.step === null) return { eligible: false, reason: "complete" };
  const step = progress.step;

  const timezone = resolveTimezone(input.timezone);
  const windowDays =
    input.windowDays !== undefined && Number.isFinite(input.windowDays) && input.windowDays >= 0
      ? Math.floor(input.windowDays)
      : DEFAULT_FOLLOW_UP_WINDOW_DAYS;

  // Step 1 counts from the application; step 2 from follow-up 1 (sent or
  // skipped). A step 2 without any recorded event falls back to the application.
  const anchor =
    step === 1 ? application.sentAt : (progress.lastEventAt ?? application.sentAt);

  const dueDay = nextWeekday(
    addCivilDays(civilDay(timezone, anchor.getTime()), FOLLOW_UP_STEP_DAYS[step]),
  );
  const dueAt = new Date(startOfCivilDay(timezone, dueDay));
  const windowEnd = new Date(startOfCivilDay(timezone, addCivilDays(dueDay, windowDays)));

  const now = input.now.getTime();
  const snoozedUntil = state?.snoozedUntil ?? null;
  let status: DueStatus;
  if (now < dueAt.getTime()) status = "scheduled";
  else if (now > windowEnd.getTime()) status = "expired";
  else if (snoozedUntil && snoozedUntil.getTime() > now) status = "snoozed";
  else status = "due";

  return { eligible: true, step, anchor, dueAt, windowEnd, status, snoozedUntil };
}

export const SNOOZE_DAYS = [3, 7] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];

// The instant a snooze of `days` ends (plain 24 h days, from `now`).
export function snoozeUntil(now: Date, days: SnoozeDays): Date {
  return new Date(now.getTime() + days * DAY_MS);
}
