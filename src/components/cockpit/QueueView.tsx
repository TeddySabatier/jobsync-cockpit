import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ChangeRequestsPromptButton } from "./ChangeRequestsPromptButton";
import FocusRefresh from "./FocusRefresh";
import QueueRow from "./QueueRow";
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
  return (
    <div className="flex flex-col gap-4 py-4">
      <FocusRefresh />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <QueueTabs tab={tab} />
        <Link
          href="/dashboard/review/settings"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          {gmail ? `Gmail: connected as ${gmail.email}` : "Gmail: not connected"}
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
