// The "active package" of a job: its highest version whose status is not
// "superseded" (cockpit/SPEC.md §2.2), per kind (D-030). A job has packages of
// two kinds: its "application" and, once that is sent, "follow_up" packages that
// reply to it. "Which package is THE application of this job" has one answer
// here: every reader of the one-application-per-job rule goes through this
// file (the helpers below, or the same `kind` filter), so a follow-up can never
// be mistaken for the application. The write paths (send, supersede) still spell
// their own `where`, because they also condition on the lock and the status they
// transition from.
// Not imported by client components: activeApplication reads the database.

import prisma from "@/lib/db";

export const NOT_SUPERSEDED = { not: "superseded" } as const;

export const PACKAGE_KINDS = ["application", "follow_up"] as const;
export type PackageKind = (typeof PACKAGE_KINDS)[number];

// A Prisma `where` for the active package(s) of `kind` in `scope` (e.g.
// { jobId, userId }). Defaults to the application, so every V0 caller keeps its
// meaning. Use with ACTIVE_PACKAGE_ORDER and `take: 1`, or with `some` / `none`.
export function activePackageWhere<T extends object>(
  scope: T,
  kind: PackageKind = "application",
) {
  return { ...scope, kind, status: NOT_SUPERSEDED };
}

// A Prisma `where` for the sent application(s) of `scope`: what blocks a second
// application (ALREADY_SENT) and what makes a job eligible for follow-ups.
export function sentApplicationWhere<T extends object>(scope: T) {
  return { ...scope, kind: "application" as const, status: "sent" as const };
}

export const ACTIVE_PACKAGE_ORDER = { version: "desc" } as const;

// The active package of a list of versions that is sorted newest first. The
// caller passes the versions of ONE kind (listJobVersions does that).
export function pickActive<T extends { status: string }>(
  versionsNewestFirst: readonly T[],
): T | null {
  return versionsNewestFirst.find((v) => v.status !== NOT_SUPERSEDED.not) ?? null;
}

type Db = Pick<typeof prisma, "applicationPackage">;

// THE application of a job: its highest non-superseded version of kind
// "application", scoped to the user. Null when the job has none. A follow-up
// package never counts, whatever its version number.
export function activeApplication(
  userId: string,
  jobId: string,
  db: Db = prisma,
) {
  return db.applicationPackage.findFirst({
    where: activePackageWhere({ jobId, userId }, "application"),
    orderBy: ACTIVE_PACKAGE_ORDER,
    select: { id: true, version: true, status: true },
  });
}
