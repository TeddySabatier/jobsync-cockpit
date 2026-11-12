import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ChangeRequestsPromptButton } from "./ChangeRequestsPromptButton";
import FocusRefresh from "./FocusRefresh";
import { todoGroup } from "@/lib/cockpit/queueOrder";
import QueueRow, { type QueueRowData } from "./QueueRow";
import QueueTabs from "./QueueTabs";
import type { QueueTabValue } from "./queueTabs";
import type { getReviewQueue } from "@/actions/cockpit.actions";

type QueueData = Extract<
  Awaited<ReturnType<typeof getReviewQueue>>,
  { success: true }
>["data"];

const EMPTY_MESSAGES: Record<QueueTabValue, string> = {
  todo: "All done: nothing to review. Use Refresh and prepare on the Jobs page to get new applications.",
  changes:
    "No changes requested. An application shows up here after you request changes, until Claude sends back a new version.",
  sent: "Nothing sent yet. Applications move here once you send them or mark them applied.",
  rejected: "No rejected applications. The ones you reject are kept here, and you can reopen them.",
};

export default function QueueView({
  tab,
  data,
}: {
  tab: QueueTabValue;
  data: QueueData;
}) {
  const { rows, gmail, gmailCalloutNeeded } = data;
  const counts = "counts" in data ? data.counts : undefined;
  return (
    <div className="flex flex-col gap-4 py-4">
      <FocusRefresh />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <QueueTabs tab={tab} counts={counts} />
        <Link
          href="/dashboard/review/settings"
          className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden
            data-testid="gmail-dot"
            className={`h-2 w-2 shrink-0 rounded-full ${gmail ? "bg-green-500" : "bg-red-500"}`}
          />
          <span className="truncate" title={gmail?.email}>
            {gmail ? `Gmail: connected as ${gmail.email}` : "Gmail: not connected"}
          </span>
        </Link>
      </div>

      {gmailCalloutNeeded && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            Gmail is not connected, so approved applications with a recipient cannot
            be sent.{" "}
            <Link
              href="/dashboard/review/settings"
              className="font-medium underline"
            >
              Connect Gmail in settings
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}

      {tab === "changes" && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
          <span className="min-w-0 flex-1">
            Claude has to answer these. Copy the prompt and paste it into Claude.
          </span>
          <ChangeRequestsPromptButton className="h-11 gap-2" variant="default" />
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {EMPTY_MESSAGES[tab]}
        </p>
      ) : tab === "todo" ? (
        <TodoSections rows={rows} gmailConnected={!!gmail} />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <QueueRow key={row.id} row={row} gmailConnected={!!gmail} />
          ))}
        </ul>
      )}
    </div>
  );
}

// To do is two groups (D-040): approved packages are ready to send, pending
// ones still need a review. The rows arrive already sorted that way.
function TodoSections({
  rows,
  gmailConnected,
}: {
  rows: QueueRowData[];
  gmailConnected: boolean;
}) {
  const groups = [
    { id: "ready", title: "Ready to send", rows: rows.filter((r) => todoGroup(r) === "ready") },
    { id: "review", title: "To review", rows: rows.filter((r) => todoGroup(r) === "review") },
  ].filter((g) => g.rows.length > 0);
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.id} aria-labelledby={`todo-${g.id}`}>
          <h2
            id={`todo-${g.id}`}
            className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {g.title} <span className="tabular-nums">({g.rows.length})</span>
          </h2>
          <ul className="flex flex-col gap-2">
            {g.rows.map((row) => (
              <QueueRow key={row.id} row={row} gmailConnected={gmailConnected} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
