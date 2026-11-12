// One label per package status, shared by the queue, the detail page and the
// job page. Never show the raw status string to the owner.
export const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  changes_requested: "Changes requested",
  sent: "Sent",
  rejected: "Rejected",
  superseded: "Superseded",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

// One colour per status (D-040). Light and dark are both spelled out; the
// text colours stay at AA contrast on their tint. Applied on a Badge with
// variant="outline" (see StatusBadge). Unknown statuses fall back to muted.
export const STATUS_CLASSES: Record<string, string> = {
  pending:
    "border-amber-500 bg-transparent text-amber-800 dark:border-amber-400 dark:text-amber-300",
  approved:
    "border-transparent bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  sent: "border-transparent bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  rejected:
    "border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  changes_requested:
    "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  superseded: "border-transparent bg-muted text-muted-foreground",
};

export function statusClass(status: string): string {
  return STATUS_CLASSES[status] ?? STATUS_CLASSES.superseded;
}
