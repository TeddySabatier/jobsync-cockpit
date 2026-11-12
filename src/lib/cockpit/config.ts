// Cockpit configuration (cockpit/SPEC.md §1 P4, §3).

import {
  DEFAULT_FOLLOW_UP_WINDOW_DAYS,
  resolveTimezone,
} from "./followUpDue";

// Read per call, never cached: the flag is checked per request.
export function isCockpitEnabled(): boolean {
  return process.env.COCKPIT_ENABLED === "true";
}

// True when the connected Gmail address is the one the owner allowed for
// sending (COCKPIT_GMAIL_ALLOWED_ADDRESS, compared trimmed and lower-cased).
// The one allow-list check: Connect (oauth.ts, which passes the address it
// already read), the Send button state and Send itself all use it.
export function isGmailSendAllowed(
  accountEmail: string | null | undefined,
  allowedAddress: string | null | undefined = process.env.COCKPIT_GMAIL_ALLOWED_ADDRESS,
): boolean {
  const allowed = allowedAddress?.trim().toLowerCase();
  if (!accountEmail || !allowed) return false;
  return accountEmail.trim().toLowerCase() === allowed;
}

// New MCP token scopes (SPEC §3). Spread into the default token scopes.
export const COCKPIT_SCOPES = ["jobs:read", "package:write"] as const;

const HOUR_MS = 60 * 60 * 1000;

// Rate-limit buckets (SPEC §3). `cockpit` applies to every cockpit tool,
// `cockpit-attach` to attach_file on top of it.
export const COCKPIT_RATE_LIMITS = {
  cockpit: { bucket: "cockpit", max: 120, windowMs: HOUR_MS },
  attach: { bucket: "cockpit-attach", max: 30, windowMs: HOUR_MS },
} as const;

// Follow-ups (D-031). Read per call. COCKPIT_TIMEZONE: IANA name the due day and
// the weekday rule are computed in (default UTC; an invalid name also gives UTC).
export function getFollowUpTimezone(): string {
  return resolveTimezone(process.env.COCKPIT_TIMEZONE);
}

// COCKPIT_FOLLOWUP_WINDOW_DAYS: how long after its due day a step is still
// suggested (default 30). A whole number from 1 to 365; anything else gives the
// default.
export function getFollowUpWindowDays(): number {
  const raw = process.env.COCKPIT_FOLLOWUP_WINDOW_DAYS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_FOLLOW_UP_WINDOW_DAYS;
  const n = Number(raw);
  return n >= 1 && n <= 365 ? n : DEFAULT_FOLLOW_UP_WINDOW_DAYS;
}
