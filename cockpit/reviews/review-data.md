# Cockpit V0 — data model review (§2, AC-01..AC-06)

## Issues

1. **Critical · §2 / AC-01** — `prisma/schema.prisma` has no `ApplicationPackage`, `GmailAccount`, or `SentEmail`, and no back-relations on `User`, `Job`, or `File`. The spec migration `20261104120000_cockpit_v0` is absent from `prisma/migrations/`. **Fix:** Add models and relations to `schema.prisma`, generate `migration.sql` with `CREATE TABLE` / `CREATE INDEX` only (no `ALTER` on existing tables), timestamp after `20260904120000`.

2. **Critical · §2.2 / AC-04** — Idempotent double-create races: two concurrent submits with the same `idempotencyKey` can both pass the read check; the loser hits `@@unique([userId, idempotencyKey])` and must be handled as “return existing package”, not a generic `CONFLICT`. **Fix:** In `submitPackage`, on P2002 for that unique target, `findFirst` by `(userId, idempotencyKey)` and return `{ idempotent: true }`.

3. **Important · §5.2 / AC-17 (query)** — Queue needs one row per job (active = max `version` where `status != 'superseded'`), tab filter on `status`, `ORDER BY createdAt DESC`. Only `@@index([userId, status])` is defined; no `createdAt` in the index and no support for per-job dedupe. **Fix:** Add `@@index([userId, status, createdAt])` (or document a raw query with `jobId` grouping and accept full scan); ensure `@@unique([jobId, version])` is present for max-version lookups.

4. **Important · §2.2 step 3 / AC-05** — `ALREADY_SENT` is “any package on job with `status = sent`”, not “active package only”. That matches AC-05 but contradicts naive “active-only” reads; historical `sent` rows block all future submits forever. **Fix:** Confirm product intent; if only the active row should block, change rule to `exists sent where version = active version` or document that any past `sent` row blocks the job.

5. **Important · §2 / integrity** — No DB constraint that `ApplicationPackage.userId` equals `Job.userId` for `jobId`. A bug or bypass could attach packages to another user’s job while passing `job.userId === userId` only if job lookup is correct. **Fix:** Optional trigger/check in SQLite is awkward; enforce in transaction with `job = findFirst({ id, userId })` (spec step 1) and never set `userId` from input alone.

6. **Important · §2 / FILE_NOT_FOUND (AC-06)** — `cvFileId` FK to `File` does not tie files to users (`File` has no `userId`). Ownership is path-prefix only in app code. **Fix:** Keep path validation in `submitPackage`; document that FK alone is insufficient; consider indexing or storing `userId` on cockpit files later.

7. **Important · §2.2 / SQLite** — Spec relies on `prisma.$transaction` + unique `(jobId, version)` for concurrent submits. SQLite serializes writers; loser gets unique violation → `CONFLICT` + retry is correct, but retry must re-run idempotency and `ALREADY_SENT` checks, not blindly bump version. **Fix:** Document retry as full transaction replay; optionally use `INSERT ... ON CONFLICT` pattern in raw SQL if Prisma retry semantics are unclear.

8. **Minor · §2 / SQLite NULLs** — `@@unique([userId, idempotencyKey])` with nullable `idempotencyKey`: SQLite treats each `NULL` as distinct, so many packages without a key per user are allowed (intended). **Fix:** None if optional key stays optional; use partial unique index only if you ever require at-most-one NULL (not needed for V0).

9. **Minor · §2.1 lifecycle** — `mark_change_request_done` → `pending` leaves `changeRequest`, `changeRequestedAt`, etc. populated; only supersede-on-resubmit sets `changeRequestHandledAt` for `changes_requested` (AC-03). **Fix:** Clarify in spec whether done→pending should clear or retain change-request fields for UI history.

10. **Minor · §2 vs existing schema** — Spec uses `onDelete: Cascade` on cockpit→`User`/`Job`; most existing `User` children (e.g. `Job`→`User`, `ApiKey`→`User`) omit cascade. **Fix:** Keep cockpit cascades as spec’d; do not “normalize” existing tables in the same migration (AC-01 additive).

11. **Minor · §2 / `Job` delete** — `ApplicationPackage`→`Job` `onDelete: Cascade` deletes all package history when a job is deleted. **Fix:** Accept for V0 or switch to `Restrict` if job deletion must preserve audit trail.

12. **Minor · AC-01 / migration style** — Latest upstream migrations are data-only (`INSERT OR IGNORE`, `DELETE`) with comment headers; cockpit migration must be pure DDL. **Fix:** Match comment + explicit SQL style; avoid mixing data fixes into `20261104120000_cockpit_v0`.
