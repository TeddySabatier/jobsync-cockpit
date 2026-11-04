// Cockpit configuration (cockpit/SPEC.md §1 P4, §3).

// Read per call, never cached: the flag is checked per request.
export function isCockpitEnabled(): boolean {
  return process.env.COCKPIT_ENABLED === "true";
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
