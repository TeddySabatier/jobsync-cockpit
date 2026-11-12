import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import {
  FileWarning,
  FileX,
  Link2,
  Loader2,
  Mail,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { sendState } from "@/lib/cockpit/queueOrder";
import FitGradeBadge from "./FitGradeBadge";
import StatusBadge from "./StatusBadge";
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

const CHIP_ICONS: Record<string, LucideIcon> = {
  Gmail: Mail,
  "PDF stale": FileWarning,
  "No CV": FileX,
  "Link apply": Link2,
};

// A readiness signal: icon plus amber tint, so it is not a plain outline chip.
export function ReadinessChip({ label }: { label: string }) {
  const Icon = CHIP_ICONS[label] ?? TriangleAlert;
  return (
    <Badge
      variant="outline"
      data-testid="readiness-chip"
      className="gap-1 border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
    >
      <Icon aria-hidden className="h-3 w-3" />
      {label}
    </Badge>
  );
}

export default function QueueRow({
  row,
  gmailConnected,
}: {
  row: QueueRowData;
  gmailConnected: boolean;
}) {
  const chips = readinessChips(row, gmailConnected);
  const state = sendState(row);
  const unknown = state === "unknown";
  const company = row.job.Company.label;
  const title = row.job.JobTitle.label;
  return (
    <li>
      <Link
        href={`/dashboard/review/${row.id}`}
        className="flex flex-col gap-2 rounded-lg border bg-card p-3 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @md/main:flex-row @md/main:flex-wrap @md/main:items-center @md/main:gap-x-4 @md/main:gap-y-2"
      >
        <div className="min-w-0 flex-1 @md/main:min-w-[10rem]">
          <p className="truncate font-medium" title={company}>
            {company}
          </p>
          <p className="truncate text-sm text-muted-foreground" title={title}>
            {title}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {unknown && (
            <Badge
              variant="outline"
              data-testid="send-unknown-chip"
              className="gap-1 border-amber-500 bg-amber-100 text-amber-900 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-300"
            >
              <TriangleAlert aria-hidden className="h-3 w-3" />
              Send unknown
            </Badge>
          )}
          {state === "sending" && (
            <Badge variant="outline" data-testid="sending-chip" className="gap-1">
              <Loader2 aria-hidden className="h-3 w-3" />
              Sending
            </Badge>
          )}
          {row.fitGrade && <FitGradeBadge grade={row.fitGrade} />}
          <span className="text-xs text-muted-foreground">v{row.version}</span>
          <StatusBadge status={row.status} />
          {chips.map((c) => (
            <ReadinessChip key={c} label={c} />
          ))}
        </div>
        <div className="min-w-0 text-sm text-muted-foreground @md/main:ml-auto @md/main:w-64 @md/main:text-right">
          <p className="truncate" title={row.emailTo?.trim() || undefined}>
            {row.emailTo?.trim() || "Apply via link"}
          </p>
          <p className="text-xs">
            {formatDistanceToNow(row.createdAt, { addSuffix: true })}
          </p>
        </div>
      </Link>
    </li>
  );
}
