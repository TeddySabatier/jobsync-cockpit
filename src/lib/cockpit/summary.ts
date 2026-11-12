// What the summary strip at the top of an application shows (D-041). Pure and
// client-safe. Everything here is derived from stored fields; optional keys the
// bot may add to the fit analysis are read defensively (it is arbitrary JSON).

function parseObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const asText = (v: unknown): string | null => {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return null;
};

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asText).filter((x): x is string => !!x);
  const t = asText(v);
  return t ? [t] : [];
}

// One line: why the grade. The bot's `reasons` (what cockpit_submit.py stores),
// else a summary-like string. At most three reasons, never raw JSON.
export function fitWhy(fitAnalysis: string | null | undefined): string | null {
  const obj = parseObject(fitAnalysis);
  if (!obj) return null;
  const reasons = asList(obj.reasons ?? obj.why ?? obj.strengths);
  if (reasons.length) return reasons.slice(0, 3).join("; ");
  return asText(obj.summary ?? obj.rationale ?? obj.reason);
}

// The bot's own "what to check in Review", when it stored one.
export function botChecks(fitAnalysis: string | null | undefined): string[] {
  const obj = parseObject(fitAnalysis);
  if (!obj) return [];
  return asList(obj.whatToCheck ?? obj.what_to_check ?? obj.toCheck ?? obj.check ?? obj.gaps).slice(0, 4);
}

export type SummaryInput = {
  status: string;
  emailTo: string | null;
  contactSource: string | null;
  fitAnalysis: string | null;
  cvPdfStale: boolean;
  hasCvFile: boolean;
  hasLetter: boolean;
  gmailConnected: boolean;
  sendBlockedReason: string | null;
  // The send lock is set (a send is running or its outcome is unknown).
  sendLocked?: boolean;
};

export type Chip = { label: string; tone: "ok" | "warn" | "info" };

// Readiness at a glance. Never says "ready" about something Send would refuse.
export function readinessChips(i: SummaryInput): Chip[] {
  const chips: Chip[] = [];
  const email = !!i.emailTo?.trim();
  chips.push(email ? { label: "Email", tone: "info" } : { label: "Apply via link", tone: "info" });
  chips.push(
    i.hasCvFile
      ? i.cvPdfStale
        ? { label: "CV PDF out of date", tone: "warn" }
        : { label: "CV PDF ready", tone: "ok" }
      : { label: "No CV file", tone: "warn" },
  );
  chips.push(i.hasLetter ? { label: "Cover letter", tone: "ok" } : { label: "No cover letter", tone: "warn" });
  // Only an open application (pending / approved) can be sent; a locked one
  // waits for the send-outcome decision, never "Can send" (review of PR #95).
  const open = i.status === "pending" || i.status === "approved";
  if (email && i.sendLocked && open) {
    chips.push({ label: "Send result unknown", tone: "warn" });
  } else if (email && open) {
    chips.push(
      i.sendBlockedReason
        ? { label: "Cannot send yet", tone: "warn" }
        : { label: "Can send", tone: "ok" },
    );
  }
  return chips;
}

// Short, plain things to look at before approving, most important first.
export function whatToCheck(i: SummaryInput): string[] {
  const out: string[] = [];
  const email = !!i.emailTo?.trim();
  if (email && !i.contactSource?.trim()) out.push("No source was recorded for the recipient: check the address.");
  if (!email) out.push("No recipient: apply on the company's site, then mark it applied.");
  if (i.cvPdfStale) out.push("The CV text was edited: ask Claude to re-render the PDF before sending.");
  if (email && i.sendBlockedReason && !i.cvPdfStale) out.push(i.sendBlockedReason);
  for (const c of botChecks(i.fitAnalysis)) out.push(c);
  return out.slice(0, 5);
}
