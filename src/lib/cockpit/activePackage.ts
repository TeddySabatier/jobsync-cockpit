// The "active package" of a job: its highest version whose status is not
// "superseded" (cockpit/SPEC.md §2.2). One definition for every reader; the
// write paths (send, supersede) still spell their own `where`, because they
// also condition on the lock and the status they transition from.
// Pure and client-safe (no Prisma import).

export const NOT_SUPERSEDED = { not: "superseded" } as const;

// A Prisma `where` for the active package(s) of `scope` (e.g. { jobId, userId }).
// Use with ACTIVE_PACKAGE_ORDER and `take: 1`, or with `some` / `none` filters.
export function activePackageWhere<T extends object>(scope: T) {
  return { ...scope, status: NOT_SUPERSEDED };
}

export const ACTIVE_PACKAGE_ORDER = { version: "desc" } as const;

// The active package of a list of versions that is sorted newest first.
export function pickActive<T extends { status: string }>(
  versionsNewestFirst: readonly T[],
): T | null {
  return versionsNewestFirst.find((v) => v.status !== NOT_SUPERSEDED.not) ?? null;
}
