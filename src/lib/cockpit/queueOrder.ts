// Pure helpers for the review queue: ordering and per-tab counts (D-040).
// No Prisma import, so a client component and a unit test can use them.

import { STALE_LOCK_MS } from "./constants";

type SendFields = {
  sendOutcome?: string | null;
  sendStartedAt?: Date | string | null;
};

// "unknown": the outcome is unknown, or the lock is older than STALE_LOCK_MS
// with no outcome (the sender died): needs action first (SPEC §6.4).
// "sending": a fresh lock, a send is probably still in flight: shown, not
// alarming. null: nothing pending.
export type SendState = "unknown" | "sending" | null;

export function sendState(row: SendFields, now: number = Date.now()): SendState {
  if (row.sendOutcome === "unknown") return "unknown";
  if (row.sendOutcome || !row.sendStartedAt) return null;
  const started = new Date(row.sendStartedAt).getTime();
  if (Number.isNaN(started)) return "unknown";
  return now - started < STALE_LOCK_MS ? "sending" : "unknown";
}

export function isSendUnknown(row: SendFields, now: number = Date.now()): boolean {
  return sendState(row, now) === "unknown";
}

// To do groups: "Ready to send" (approved) before "To review" (pending).
export type TodoGroup = "ready" | "review";

export function todoGroup(row: { status: string }): TodoGroup {
  return row.status === "approved" ? "ready" : "review";
}

// Send-unknown first, then approved, then pending. Array.prototype.sort is
// stable, so the incoming order (newest first) holds inside each rank.
export function sortTodoRows<
  T extends { status: string } & SendFields,
>(rows: T[], now: number = Date.now()): T[] {
  const rank = (r: T) => (isSendUnknown(r, now) ? 0 : todoGroup(r) === "ready" ? 1 : 2);
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
