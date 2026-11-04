import { notFound, redirect } from "next/navigation";
import { getReviewQueue } from "@/actions/cockpit.actions";
import QueueView from "@/components/cockpit/QueueView";
import { QUEUE_TABS, parseQueueTab } from "@/components/cockpit/queueTabs";

// The page authenticates itself through the action (requireUser runs first
// inside it); the dashboard layout is not a guard (SPEC §5, AC-40).
export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { tab: rawTab } = await searchParams;
  const tab = parseQueueTab(rawTab);
  const result = await getReviewQueue(tab);

  if (!result.success) {
    if (result.code === "UNAUTHENTICATED") redirect("/signin");
    if (result.code === "COCKPIT_DISABLED") notFound();
    return (
      <p role="alert" className="py-4 text-sm text-destructive">
        {result.message}
      </p>
    );
  }

  return <QueueView tab={tab} tabs={QUEUE_TABS} data={result.data} />;
}
