// Pure helpers for the review queue: ordering and per-tab counts (D-040).
// No Prisma import, so a client component and a unit test can use them.

// A package whose send result is unknown, or whose send lock is still held,
// is the one row that needs action first (SPEC §6.4).
export function isSendUnknown(row: {
  sendOutcome?: string | null;
  sendStartedAt?: Date | string | null;
}): boolean {
  return row.sendOutcome === "unknown" || !!row.sendStartedAt;
}

// To do groups: "Ready to send" (approved) before "To review" (pending).
export type TodoGroup = "ready" | "review";

export function todoGroup(row: { status: string }): TodoGroup {
  return row.status === "approved" ? "ready" : "review";
}

// Send-unknown first, then approved, then pending. Array.prototype.sort is
// stable, so the incoming order (newest first) holds inside each rank.
export function sortTodoRows<
  T extends {
    status: string;
    sendOutcome?: string | null;
    sendStartedAt?: Date | string | null;
  },
>(rows: T[]): T[] {
  const rank = (r: T) => (isSendUnknown(r) ? 0 : todoGroup(r) === "ready" ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

// status -> count rows (a groupBy result) to one count per tab.
export function tabCounts<Tab extends string>(
  groups: { status: string; count: number }[],
  tabStatuses: Record<Tab, readonly string[]>,
): Record<Tab, number> {
  const byStatus = new Map(groups.map((g) => [g.status, g.count]));
  const out = {} as Record<Tab, number>;
  for (const tab of Object.keys(tabStatuses) as Tab[]) {
    out[tab] = (tabStatuses[tab] as readonly string[]).reduce<number>((n, s) => n + (byStatus.get(s) ?? 0), 0);
  }
  return out;
}
