// Auto-advance after a terminal action (Send, Mark applied, Reject; D-041).
// Pure: where to go and what to tell the owner. Only ever called after a
// confirmed success: never on a failure and never on the unknown-outcome state.

export const REVIEW_HOME = "/dashboard/review";

export type AdjacentIds = {
  previousId: string | null;
  nextId: string | null;
  // Other To do applications besides this one (null: not known, e.g. old caller).
  todoLeft?: number | null;
};

export type AdvanceTarget = {
  // The next application, or the queue (whose To do tab then says "All done").
  href: string;
  left: number;
  done: boolean;
};

// The next To do item in queue order; when this was the last one, the one
// before it; when none is left, the queue.
export function pickAdvanceTarget(adj: AdjacentIds): AdvanceTarget {
  const id = adj.nextId ?? adj.previousId;
  if (id) {
    const left = adj.todoLeft ?? 1;
    return { href: `${REVIEW_HOME}/${id}`, left: Math.max(1, left), done: false };
  }
  return { href: REVIEW_HOME, left: 0, done: true };
}

export function advanceMessage(base: string, target: AdvanceTarget): string {
  if (target.done) return `${base}. All done: nothing left to review.`;
  return `${base}. ${target.left} left to review.`;
}
