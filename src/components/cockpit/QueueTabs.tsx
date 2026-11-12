import Link from "next/link";
import { cn } from "@/lib/utils";
import { QUEUE_TABS, type QueueTabValue } from "./queueTabs";

// Counts are optional: without them (or for a tab missing from the map) the
// tab shows only its label.
export default function QueueTabs({
  tab,
  counts,
}: {
  tab: QueueTabValue;
  counts?: Partial<Record<QueueTabValue, number>>;
}) {
  return (
    <nav
      aria-label="Review queue filters"
      className="-mx-1 flex max-w-full flex-nowrap gap-1 overflow-x-auto px-1"
    >
      {QUEUE_TABS.map((t) => {
        const count = counts?.[t.value];
        return (
          <Link
            key={t.value}
            href={`/dashboard/review?tab=${t.value}`}
            aria-current={t.value === tab ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              t.value === tab
                ? "bg-accent text-foreground"
                : "text-muted-foreground",
            )}
          >
            {t.label}
            {typeof count === "number" && (
              <span
                data-testid="tab-count"
                className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-foreground"
              >
                {count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
