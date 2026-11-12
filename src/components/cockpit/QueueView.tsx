import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import QueueRow from "./QueueRow";
import QueueTabs from "./QueueTabs";
import type { QueueTabValue } from "./queueTabs";
import type { getReviewQueue } from "@/actions/cockpit.actions";

type QueueData = Extract<
  Awaited<ReturnType<typeof getReviewQueue>>,
  { success: true }
>["data"];

const EMPTY_MESSAGES: Record<QueueTabValue, string> = {
  todo: "Nothing to review. Application packages appear here when your bot submits one through the MCP tools.",
  changes:
    "No packages are waiting for changes. Packages show up here after you request changes and until the bot resubmits.",
  sent: "Nothing sent yet. Packages move here once you send them or mark them applied.",
  rejected: "No rejected packages. Packages you reject are kept here.",
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
            Gmail is not connected, so approved packages with a recipient cannot
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
