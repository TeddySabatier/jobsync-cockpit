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
