import Link from "next/link";
import { cn } from "@/lib/utils";
import { QUEUE_TABS, type QueueTabValue } from "./queueTabs";

export default function QueueTabs({ tab }: { tab: QueueTabValue }) {
  return (
    <nav aria-label="Review queue filters" className="flex flex-wrap gap-1">
      {QUEUE_TABS.map((t) => (
        <Link
          key={t.value}
          href={`/dashboard/review?tab=${t.value}`}
          aria-current={t.value === tab ? "page" : undefined}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium hover:text-foreground",
            t.value === tab
              ? "bg-accent text-foreground"
              : "text-muted-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
