// Queue filter tabs (SPEC §5.2), selected by the `?tab=` query param.
export const QUEUE_TABS = [
  { value: "todo", label: "To do" },
  { value: "changes", label: "Changes requested" },
  { value: "sent", label: "Sent" },
  { value: "rejected", label: "Rejected" },
] as const;

export type QueueTabValue = (typeof QUEUE_TABS)[number]["value"];

// Unknown or repeated values fall back to the default tab.
export function parseQueueTab(raw: unknown): QueueTabValue {
  return QUEUE_TABS.find((t) => t.value === raw)?.value ?? "todo";
}
