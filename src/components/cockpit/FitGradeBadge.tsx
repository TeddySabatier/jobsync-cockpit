import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// A is green, B amber, anything else stays neutral.
export function gradeClass(grade: string): string {
  switch (grade.trim().toUpperCase()) {
    case "A":
      return "border-green-600 text-green-800 dark:border-green-500 dark:text-green-300";
    case "B":
      return "border-amber-500 text-amber-800 dark:border-amber-400 dark:text-amber-300";
    default:
      return "";
  }
}

// The grade badge of the queue row, the detail header and the fit panel. The
// "Fit grade" prefix is real (screen-reader only) text: aria-label on a plain
// span is not announced.
export default function FitGradeBadge({ grade }: { grade: string }) {
  return (
    <Badge variant="outline" className={cn(gradeClass(grade))}>
      <span className="sr-only">Fit grade </span>
      {grade}
    </Badge>
  );
}
