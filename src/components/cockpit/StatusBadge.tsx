import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { statusClass, statusLabel } from "./statusLabels";

// The status chip of the queue, the detail header, the version select area and
// the job page. The colour comes from one map (statusLabels.ts).
export default function StatusBadge({
  status,
  className,
  label,
}: {
  status: string;
  className?: string;
  label?: string;
}) {
  return (
    <Badge
      variant="outline"
      data-status={status}
      className={cn(statusClass(status), className)}
    >
      {label ?? statusLabel(status)}
    </Badge>
  );
}
