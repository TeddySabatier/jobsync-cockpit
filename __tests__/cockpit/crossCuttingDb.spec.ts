// @vitest-environment node
import fs from "fs";
import path from "path";

// Issue #63 review, real SQLite: the shared active-package helper returns what
// the hand-written queries returned, and the Gmail reads select only what the
// callers need.

const db = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("./helpers/sqlite");
  return createCockpitTestDb();
});
vi.mock("@/lib/db", () => ({ default: db.prisma }));

import { ACTIVE_PACKAGE_ORDER, activePackageWhere, pickActive } from "@/lib/cockpit/activePackage";
import { findGmailPublic, findGmailTokens } from "@/lib/cockpit/connectedAccount";
import { listJobVersions } from "@/lib/cockpit/packages";
import { createJobFor, seedUserWithRefs, type SeededUser } from "./helpers/seedUser";

const prisma = db.prisma;
let a: SeededUser;
let b: SeededUser;
let statusId: string;

// [version, status] lists, deliberately including superseded rows with the
// HIGHEST version and out-of-order insertion.
const CASES: Record<string, Array<[number, string]>> = {
  none: [],
  onlySuperseded: [[1, "superseded"], [2, "superseded"]],
  oneSent: [[1, "superseded"], [2, "sent"]],
  rejectedActive: [[1, "superseded"], [2, "rejected"]],
  supersededHighest: [[1, "pending"], [2, "superseded"], [3, "superseded"]],
  sentThenRejectedImpossibleButStored: [[1, "sent"], [2, "rejected"]],
  mixed: [[4, "superseded"], [1, "approved"], [3, "changes_requested"], [2, "superseded"]],
  unlockedApproved: [[1, "superseded"], [2, "superseded"], [3, "approved"]],
};
const jobs: Record<string, string> = {};
let otherUsersJob: string;

const mkPkg = (userId: string, jobId: string, version: number, status: string) =>
  prisma.applicationPackage.create({
    data: { userId, jobId, version, status, emailSubject: "s", emailBody: "b" },
  });

beforeAll(async () => {
  a = await seedUserWithRefs(prisma, "a@example.com");
  b = await seedUserWithRefs(prisma, "b@example.com");
  statusId = (await prisma.jobStatus.create({ data: { label: "Draft", value: "draft" } })).id;
  for (const [name, list] of Object.entries(CASES)) {
    jobs[name] = await createJobFor(prisma, a, statusId);
    for (const [v, s] of list) await mkPkg(a.id, jobs[name], v, s);
  }
  // User B holds an ACTIVE package on a job whose userId is A (cannot happen
  // through the app; it proves the userId scope of some/none is kept).
  otherUsersJob = await createJobFor(prisma, a, statusId);
  await mkPkg(b.id, otherUsersJob, 1, "pending");
}, 120_000);
afterAll(() => db.cleanup());

// The code as it was before #63.
const oldFirstActive = (jobId: string) =>
  prisma.applicationPackage.findFirst({
    where: { jobId, status: { not: "superseded" } },
    orderBy: { version: "desc" },
    select: { status: true },
  });
const newFirstActive = (jobId: string) =>
  prisma.applicationPackage.findFirst({
    where: activePackageWhere({ jobId }),
    orderBy: ACTIVE_PACKAGE_ORDER,
    select: { status: true },
  });

describe("active package: new helper vs the old hand-written queries", () => {
  it.each(Object.keys(CASES))("submit rejected check / findFirst: %s", async (name) => {
    expect(await newFirstActive(jobs[name])).toEqual(await oldFirstActive(jobs[name]));
  });

  it.each(Object.keys(CASES))("getPackageDetail / job page pickActive: %s", async (name) => {
    const versions = await listJobVersions(a.id, jobs[name]);
    const oldActive = versions.find((v) => v.status !== "superseded") ?? null;
    expect(pickActive(versions)).toEqual(oldActive);
    // and it is the same row the DB-side query picks
    const dbActive = await prisma.applicationPackage.findFirst({
      where: activePackageWhere({ jobId: jobs[name], userId: a.id }),
      orderBy: ACTIVE_PACKAGE_ORDER,
      select: { id: true },
    });
    expect(pickActive(versions)?.id ?? null).toBe(dbActive?.id ?? null);
  });

  it.each([true, false])("MCP list_jobs hasPackage=%s: same job ids and same nested package", async (has) => {
    for (const user of [a, b]) {
      const userId = user.id;
      const oldWhere = {
        userId: a.id,
        applicationPackages: has
          ? { some: { userId, status: { not: "superseded" } } }
          : { none: { userId, status: { not: "superseded" } } },
      };
      const newWhere = {
        userId: a.id,
        applicationPackages: has
          ? { some: activePackageWhere({ userId }) }
          : { none: activePackageWhere({ userId }) },
      };
      const oldRows = await prisma.job.findMany({ where: oldWhere, orderBy: { id: "asc" }, select: { id: true } });
      const newRows = await prisma.job.findMany({ where: newWhere as never, orderBy: { id: "asc" }, select: { id: true } });
      expect(newRows).toEqual(oldRows);
    }
    const sel = (where: object, order: object) =>
      prisma.job.findMany({
        where: { userId: a.id },
        orderBy: { id: "asc" },
        select: {
          id: true,
          applicationPackages: { where: where as never, orderBy: order as never, take: 1, select: { id: true, version: true, status: true } },
        },
      });
    expect(await sel(activePackageWhere({ userId: a.id }), ACTIVE_PACKAGE_ORDER)).toEqual(
      await sel({ userId: a.id, status: { not: "superseded" } }, { version: "desc" }),
    );
  });

  it("the helper does not mutate or share state between calls", () => {
    const s1 = activePackageWhere({ jobId: "x" });
    const s2 = activePackageWhere({ jobId: "y" });
    expect(s1).toEqual({ jobId: "x", status: { not: "superseded" } });
    expect(s2).toEqual({ jobId: "y", status: { not: "superseded" } });
  });
});

describe("connectedAccount selects", () => {
  beforeAll(async () => {
    await prisma.gmailAccount.create({
      data: { userId: a.id, email: "me@example.com", scopes: "openid gmail.send", encryptedRefreshToken: "ENC-TOKEN", iv: "IV-VALUE" },
    });
  });
  it("findGmailPublic returns exactly email and scopes, never a token", async () => {
    const r = await findGmailPublic(a.id);
    expect(r).toEqual({ email: "me@example.com", scopes: "openid gmail.send" });
    expect(JSON.stringify(r)).not.toMatch(/ENC-TOKEN|IV-VALUE/);
    expect(await findGmailPublic(b.id)).toBeNull();
  });
  it("findGmailTokens returns exactly the token and iv", async () => {
    expect(await findGmailTokens(a.id)).toEqual({ encryptedRefreshToken: "ENC-TOKEN", iv: "IV-VALUE" });
    expect(await findGmailTokens(b.id)).toBeNull();
  });
  it("no client-reachable file imports findGmailTokens; actions use it only in the Gmail settings actions", () => {
    const root = process.cwd();
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : [],
      );
    const users = walk(path.join(root, "src"))
      .filter((f) => fs.readFileSync(f, "utf8").includes("findGmailTokens"))
      .map((f) => path.relative(root, f).split(path.sep).join("/"))
      .sort();
    expect(users).toEqual([
      "src/actions/cockpitGmail.actions.ts",
      "src/app/api/cockpit/gmail/callback/route.ts",
      "src/lib/cockpit/connectedAccount.ts",
    ]);
  });
});
