import { Badge } from "@/components/ui/badge";

// The grade badge of the queue row, the detail header and the fit panel. The
// "Fit grade" prefix is real (screen-reader only) text: aria-label on a plain
// span is not announced.
export default function FitGradeBadge({ grade }: { grade: string }) {
  return (
    <Badge variant="outline">
      <span className="sr-only">Fit grade </span>
      {grade}
    </Badge>
  );
}
