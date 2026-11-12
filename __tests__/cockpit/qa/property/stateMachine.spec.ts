// @vitest-environment node
import fc from "fast-check";
import type { ApplicationPackage } from "@prisma/client";
import { DB_RUNS, fcParams, tag } from "./_fc";

// Property 7 (SPEC §2, D-008): random walks over the package service on the
// real migrated SQLite schema. The lock / release / mark-sent steps are a hand
// written MODEL of the conditional updates send.ts issues (sendStartedAt claim,
// release, success): they show how the package service reacts to a locked or
// sent row, but they do not run send.ts. send.ts itself is covered by
// send.integration.spec.ts.
const db = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("../../helpers/sqlite");
  return createCockpitTestDb();
});

vi.mock("@/lib/db", () => ({ default: db.prisma }));

import {
  approvePackage,
  markChangeRequestDone,
  rejectPackage,
  requestPackageChanges,
  submitPackage,
  unapprovePackage,
  updatePackageContent,
} from "@/lib/cockpit/packages";
import type { SubmitApplicationPackageInput } from "@/lib/cockpit/schemas";
import { createJobFor, seedUserWithRefs, type SeededUser } from "../../helpers/seedUser";

const prisma = db.prisma;
let userId: string;
let seeded: SeededUser;
let draftId: string;
let runNo = 0;

beforeAll(async () => {
  seeded = await seedUserWithRefs(prisma, "jane@example.com");
  userId = seeded.id;
  draftId = (await prisma.jobStatus.create({ data: { label: "Draft", value: "draft" } })).id;
}, 120_000);
afterAll(() => db.cleanup());

const newJob = () => createJobFor(prisma, seeded, draftId);

const submitInput = (jobId: string, key?: string): SubmitApplicationPackageInput => ({
  jobId,
  emailTo: "hr@example.com",
  emailSubject: "Application - Engineer",
  emailBody: "Hello, I am Jane Doe.",
  fitGrade: "A",
  idempotencyKey: key,
});

const KINDS = ["submit", "approve", "unapprove", "reject", "changes", "done", "edit", "lock", "release", "sent"] as const;
type Op = { k: (typeof KINDS)[number]; job: number; key: number | null; pick: number };
const opArb: fc.Arbitrary<Op> = fc.record({
  k: fc.constantFrom(...KINDS),
  job: fc.integer({ min: 0, max: 1 }),
  key: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
  pick: fc.nat(1000),
});

type Status = ApplicationPackage["status"];
// SPEC §2.1: allowed source states per service transition (all require unlocked).
const TRANSITIONS: Record<string, { from: Status[]; to?: Status }> = {
  approve: { from: ["pending"], to: "approved" },
  unapprove: { from: ["approved"], to: "pending" },
  reject: { from: ["pending", "approved"], to: "rejected" },
  changes: { from: ["pending", "approved"], to: "changes_requested" },
  done: { from: ["changes_requested"], to: "pending" },
  edit: { from: ["pending", "approved"] },
};
const OPEN: Status[] = ["pending", "approved", "changes_requested"];

type Snap = Map<string, ApplicationPackage>;
const snap = async (jobIds: string[]): Promise<Snap> =>
  new Map(
    (await prisma.applicationPackage.findMany({ where: { jobId: { in: jobIds } } })).map((r) => [r.id, r]),
  );

function expectOnlyChanged(before: Snap, after: Snap, changed: string[]) {
  expect([...after.keys()].filter((id) => !before.has(id) && !changed.includes(id))).toEqual([]);
  for (const [id, row] of before) if (!changed.includes(id)) expect(after.get(id)).toEqual(row);
}

function globalInvariants(after: Snap, jobIds: string[]) {
  for (const jobId of jobIds) {
    const rows = [...after.values()].filter((r) => r.jobId === jobId);
    expect(rows.map((r) => r.version).sort((a, b) => a - b)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.filter((r) => OPEN.includes(r.status))).toHaveLength(
      Math.min(1, rows.filter((r) => OPEN.includes(r.status)).length),
    );
  }
  const keyed = [...after.values()].filter((r) => r.idempotencyKey);
  const byKey = new Map<string, Set<string>>();
  for (const r of keyed) byKey.set(r.idempotencyKey!, (byKey.get(r.idempotencyKey!) ?? new Set()).add(r.jobId));
  for (const [, jobs] of byKey) expect(jobs.size).toBe(1);
  expect(new Set(keyed.map((r) => r.idempotencyKey)).size).toBe(keyed.length);
}

const codeOf = (e: unknown) => (e as { code?: string })?.code;

describe(tag("package state machine properties"), () => {
  it("random service walks keep the SPEC §2 invariants", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 25 }), async (ops) => {
        const jobIds = [await newJob(), await newJob()];
        const tagStr = `r${++runNo}`;
        const known: string[] = [];

        for (const op of ops) {
          const before = await snap(jobIds);
          let err: unknown;
          let changed: string[] = [];
          const jobId = jobIds[op.job];

          if (op.k === "submit") {
            const key = op.key === null ? undefined : `${tagStr}-${op.key}`;
            const mine = [...before.values()].filter((r) => r.jobId === jobId);
            const keyRow = key ? [...before.values()].find((r) => r.idempotencyKey === key) : undefined;
            const active = mine
              .filter((r) => r.status !== "superseded")
              .sort((a, b) => b.version - a.version)[0];
            let expected: "ok" | "replay" | string;
            if (keyRow) expected = keyRow.jobId === jobId ? "replay" : "CONFLICT";
            else if (mine.some((r) => r.status === "sent")) expected = "ALREADY_SENT";
            else if (active?.status === "rejected") expected = "JOB_REJECTED";
            else if (mine.some((r) => r.sendStartedAt !== null)) expected = "CONFLICT";
            else expected = "ok";

            let res: Awaited<ReturnType<typeof submitPackage>> | undefined;
            try {
              res = await submitPackage(userId, submitInput(jobId, key));
            } catch (e) {
              err = e;
            }
            const after = await snap(jobIds);
            if (expected === "ok") {
              expect(err).toBeUndefined();
              const open = mine.filter((r) => OPEN.includes(r.status) && r.sendStartedAt === null).map((r) => r.id);
              expect(res!.idempotent).toBe(false);
              expect(res!.package.version).toBe(mine.length + 1);
              expect(res!.package.status).toBe("pending");
              expect([...res!.supersededIds].sort()).toEqual([...open].sort());
              for (const id of open) expect(after.get(id)!.status).toBe("superseded");
              known.push(res!.package.id);
              changed = [...open, res!.package.id];
            } else if (expected === "replay") {
              expect(err).toBeUndefined();
              expect(res!.idempotent).toBe(true);
              expect(res!.package.id).toBe(keyRow!.id);
            } else {
              expect(codeOf(err)).toBe(expected);
            }
            expectOnlyChanged(before, after, changed);
            globalInvariants(after, jobIds);
            continue;
          }

          if (!known.length) continue;
          const id = known[op.pick % known.length];
          const row = before.get(id)!;

          if (op.k === "lock" || op.k === "release" || op.k === "sent") {
            // Same conditional updates as send.ts (claim / release / success).
            const where =
              op.k === "lock"
                ? { id, status: "approved" as const, sendStartedAt: null }
                : { id, status: "approved" as const, sendStartedAt: { not: null } };
            const data =
              op.k === "lock"
                ? { sendStartedAt: new Date() }
                : op.k === "release"
                  ? { sendStartedAt: null, sendOutcome: null }
                  : { status: "sent" as const, sentVia: "gmail", sentAt: new Date() };
            const res = await prisma.applicationPackage.updateMany({ where, data });
            const after = await snap(jobIds);
            expectOnlyChanged(before, after, res.count ? [id] : []);
            globalInvariants(after, jobIds);
            continue;
          }

          const t = TRANSITIONS[op.k];
          const allowed = t.from.includes(row.status) && row.sendStartedAt === null;
          try {
            if (op.k === "approve") await approvePackage(userId, id);
            else if (op.k === "unapprove") await unapprovePackage(userId, id);
            else if (op.k === "reject") await rejectPackage(userId, id, "Not interested");
            else if (op.k === "changes") await requestPackageChanges(userId, id, "Shorten the letter");
            else if (op.k === "done") await markChangeRequestDone(userId, id, "Done");
            else await updatePackageContent(userId, id, { emailBody: `edited ${tagStr}` });
          } catch (e) {
            err = e;
          }
          const after = await snap(jobIds);
          if (allowed) {
            expect(err).toBeUndefined();
            const now = after.get(id)!;
            if (t.to) expect(now.status).toBe(t.to);
            else expect(now.status).toBe(row.status);
            expect(now.emailBody).toBe(op.k === "edit" ? `edited ${tagStr}` : row.emailBody);
            expect(now.emailSubject).toBe(row.emailSubject);
            expect(now.emailTo).toBe(row.emailTo);
            expect(now.version).toBe(row.version);
            expect(now.jobId).toBe(row.jobId);
            changed = [id];
          } else {
            expect(codeOf(err)).toBe("INVALID_STATE");
          }
          expectOnlyChanged(before, after, changed);
          globalInvariants(after, jobIds);
        }
      }),
      fcParams(DB_RUNS),
    );
  }, 600_000);
});
