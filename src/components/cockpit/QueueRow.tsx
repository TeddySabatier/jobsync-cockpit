import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import FitGradeBadge from "./FitGradeBadge";
import { statusLabel } from "./statusLabels";
import type { getReviewQueue } from "@/actions/cockpit.actions";

type QueueData = Extract<
  Awaited<ReturnType<typeof getReviewQueue>>,
  { success: true }
>["data"];
export type QueueRowData = QueueData["rows"][number];

// Readiness chips (SPEC §5.2): shown only for a problem or a mode.
export function readinessChips(row: QueueRowData, gmailConnected: boolean) {
  const chips: string[] = [];
  const hasEmail = !!row.emailTo?.trim();
  if (hasEmail && !gmailConnected) chips.push("Gmail");
  if (row.cvPdfStale) chips.push("PDF stale");
  if (!row.cvFileId) chips.push("No CV");
  if (!hasEmail) chips.push("Link apply");
  return chips;
}

export default function QueueRow({
  row,
  gmailConnected,
}: {
  row: QueueRowData;
  gmailConnected: boolean;
}) {
  const chips = readinessChips(row, gmailConnected);
  return (
    <li>
      <Link
        href={`/dashboard/review/${row.id}`}
        className="flex flex-col gap-2 rounded-lg border bg-card p-3 hover:bg-accent/50 @md/main:flex-row @md/main:items-center @md/main:gap-4"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{row.job.Company.label}</p>
          <p className="truncate text-sm text-muted-foreground">
            {row.job.JobTitle.label}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {row.fitGrade && <FitGradeBadge grade={row.fitGrade} />}
          <span className="text-xs text-muted-foreground">v{row.version}</span>
          <Badge variant="secondary">{statusLabel(row.status)}</Badge>
          {chips.map((c) => (
            <Badge key={c} variant="outline" data-testid="readiness-chip">
              {c}
            </Badge>
          ))}
        </div>
        <div className="min-w-0 text-sm text-muted-foreground @md/main:w-64 @md/main:text-right">
          <p className="truncate">{row.emailTo?.trim() || "Apply via link"}</p>
          <p className="text-xs">
            {formatDistanceToNow(row.createdAt, { addSuffix: true })}
          </p>
        </div>
      </Link>
    </li>
  );
}
