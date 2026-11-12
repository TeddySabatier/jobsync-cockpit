import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { fitWhy, readinessChips, whatToCheck, type Chip } from "@/lib/cockpit/summary";
import { sendBlockedReason } from "@/lib/cockpit/sendBlocked";
import FitGradeBadge from "./FitGradeBadge";
import type { PackageDetail } from "./Panels";

const TONE: Record<Chip["tone"], string> = {
  ok: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  warn: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  info: "text-muted-foreground",
};

// The first thing on an application: what it is, why that grade, who it goes to
// and where the address came from, whether it can go out, and what to look at
// (D-041). Everything is derived from stored fields; nothing here is generated.
export default function SummaryStrip({ detail }: { detail: PackageDetail }) {
  const pkg = detail.package;
  const to = pkg.emailTo?.trim() || null;
  const source = pkg.contactSource?.trim() || null;
  const input = {
    status: pkg.status,
    emailTo: to,
    contactSource: source,
    fitAnalysis: pkg.fitAnalysis,
    cvPdfStale: pkg.cvPdfStale,
    hasCvFile: !!detail.attachment,
    hasLetter: !!pkg.letterMd?.trim(),
    gmailConnected: !!detail.gmail,
    sendBlockedReason: sendBlockedReason(detail),
    sendLocked: !!pkg.sendStartedAt,
  };
  const why = fitWhy(pkg.fitAnalysis);
  const chips = readinessChips(input);
  const checks = whatToCheck(input);

  return (
    <section
      aria-label="Summary"
      data-testid="summary-strip"
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"
    >
      <div className="flex items-start gap-3">
        {pkg.fitGrade && <FitGradeBadge grade={pkg.fitGrade} />}
        <p className="min-w-0 text-sm [overflow-wrap:anywhere]" data-testid="summary-why">
          {why ?? <span className="text-muted-foreground">No reason given for the grade.</span>}
        </p>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">To</dt>
        <dd className="break-all font-medium" data-testid="summary-to">
          {to ?? "Apply via link"}
        </dd>
        {to && (
          <>
            <dt className="text-muted-foreground">Found at</dt>
            <dd className="break-all" data-testid="summary-source">
              {source ?? (
                <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  No source recorded
                </span>
              )}
            </dd>
          </>
        )}
      </dl>

      <ul className="flex flex-wrap gap-2" aria-label="Readiness">
        {chips.map((c) => (
          <li
            key={c.label}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
              TONE[c.tone],
            )}
          >
            {c.tone === "ok" ? (
              <CheckCircle2 className="h-3 w-3" aria-hidden />
            ) : c.tone === "warn" ? (
              <AlertTriangle className="h-3 w-3" aria-hidden />
            ) : (
              <Info className="h-3 w-3" aria-hidden />
            )}
            {c.label}
          </li>
        ))}
      </ul>

      {checks.length > 0 && (
        <div data-testid="summary-checks">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What to check
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {checks.map((c) => (
              <li key={c} className="[overflow-wrap:anywhere]">
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
