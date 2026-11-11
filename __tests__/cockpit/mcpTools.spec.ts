// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";

const db = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("./helpers/sqlite");
  return createCockpitTestDb();
});
const uploads = vi.hoisted(() => ({ dir: "" }));

vi.mock("@/lib/db", () => ({ default: db.prisma }));
vi.mock("@/lib/constants", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/constants")>();
  return {
    ...mod,
    APP_CONSTANTS: {
      ...mod.APP_CONSTANTS,
      get UPLOADS_DIR() {
        return uploads.dir;
      },
    },
  };
});

import { COCKPIT_ERROR_MESSAGES } from "@/lib/cockpit/errors";
import { cockpitUserDir } from "@/lib/cockpit/files";
import { ALL_SCOPES, connectCockpit, pdfBase64 } from "./helpers/mcpClient";
import { createJobFor, seedUserWithRefs, type SeededUser } from "./helpers/seedUser";

const prisma = db.prisma;

let userA: string;
let userB: string;
let draftId: string;
const refs: Record<string, SeededUser> = {};

async function seedUser(email: string) {
  const u = await seedUserWithRefs(prisma, email);
  refs[u.id] = u;
  return u.id;
}

const newJob = (userId: string, over: Record<string, unknown> = {}) =>
  createJobFor(prisma, refs[userId], draftId, over);

const submitArgs = (jobId: string, over: Record<string, unknown> = {}) => ({
  jobId,
  emailTo: "hr@example.com",
  emailSubject: "Application - Engineer",
  emailBody: "Hello, I am Jane Doe.",
  fitGrade: "A",
  ...over,
});

const errorText = (code: keyof typeof COCKPIT_ERROR_MESSAGES) =>
  `${code}: ${COCKPIT_ERROR_MESSAGES[code]}`;

async function asUser(userId: string) {
  return connectCockpit({ userId, tokenName: "bot", scopes: ALL_SCOPES });
}

beforeAll(async () => {
  uploads.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-mcp-"));
  userA = await seedUser("jane@example.com");
  userB = await seedUser("john@example.com");
  draftId = (
    await prisma.jobStatus.create({ data: { label: "Draft", value: "draft" } })
  ).id;
}, 120_000);

afterAll(async () => {
  fs.rmSync(uploads.dir, { recursive: true, force: true });
  await db.cleanup();
});

describe("registered tools", () => {
  it("are exactly the six cockpit tools, none for send / approve / reject (AC-13)", async () => {
    const { client, close } = await asUser(userA);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    await close();
    expect(names).toEqual([
      "attach_file",
      "get_job",
      "list_change_requests",
      "list_jobs",
      "mark_change_request_done",
      "submit_application_package",
    ]);
    expect(names.filter((n) => /send|approve|reject/.test(n))).toEqual([]);
  });
});

describe("attach_file + submit_application_package", () => {
  it("stores the PDF under the user's cockpit dir and links it to a package (AC-08)", async () => {
    const c = await asUser(userA);
    const jobId = await newJob(userA);

    const att = await c.call("attach_file", {
      fileName: "../../etc/Jane Doe CV.pdf",
      mimeType: "application/pdf",
      contentBase64: pdfBase64(),
    });
    expect(att.isError).toBe(false);
    const file = JSON.parse(att.text);
    expect(file.fileName).toBe("_.._etc_Jane_Doe_CV.pdf");
    expect(file.sizeBytes).toBeGreaterThan(0);

    const row = await prisma.file.findUniqueOrThrow({ where: { id: file.fileId } });
    expect(row.fileType).toBe("application/pdf");
    expect(path.dirname(path.resolve(row.filePath))).toBe(
      path.resolve(cockpitUserDir(userA)),
    );
    expect(path.basename(row.filePath)).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(fs.readFileSync(row.filePath).subarray(0, 4).toString()).toBe("%PDF");

    const sub = await c.call(
      "submit_application_package",
      submitArgs(jobId, { cvFileId: file.fileId, idempotencyKey: "k-1" }),
    );
    expect(sub.isError).toBe(false);
    expect(JSON.parse(sub.text)).toMatchObject({
      version: 1,
      status: "pending",
      supersededIds: [],
      idempotent: false,
    });

    // Same key again: the existing package, no new version.
    const again = await c.call(
      "submit_application_package",
      submitArgs(jobId, { idempotencyKey: "k-1" }),
    );
    expect(JSON.parse(again.text)).toMatchObject({ version: 1, idempotent: true });

    // get_job: cvFile instead of cvFileId.
    const got = JSON.parse((await c.call("get_job", { jobId })).text);
    expect(got.packages).toHaveLength(1);
    expect(got.packages[0]).not.toHaveProperty("cvFileId");
    expect(got.packages[0].cvFile).toEqual({ id: file.fileId, fileName: file.fileName });
    await c.close();
  });

  it("rejects a non-PDF with VALIDATION and stores nothing (AC-08)", async () => {
    const c = await asUser(userB);
    const before = await prisma.file.count();
    const res = await c.call("attach_file", {
      fileName: "x.pdf",
      mimeType: "application/pdf",
      contentBase64: Buffer.from("PK\u0003\u0004 not a pdf").toString("base64"),
    });
    expect(res).toEqual({ isError: true, text: errorText("VALIDATION") });
    expect(await prisma.file.count()).toBe(before);
    await c.close();
  });

  it("rejects more than 5 MB decoded with TOO_LARGE", async () => {
    const c = await asUser(userB);
    const big = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.alloc(5 * 1024 * 1024 + 1, 0x20),
    ]).toString("base64");
    expect(big.length).toBeLessThanOrEqual(7_000_000);
    const res = await c.call("attach_file", {
      fileName: "big.pdf",
      mimeType: "application/pdf",
      contentBase64: big,
    });
    expect(res).toEqual({ isError: true, text: errorText("TOO_LARGE") });
    await c.close();
  });

  it("returns isError for contentBase64 over 7,000,000 chars (SDK shape error, AC-38)", async () => {
    const c = await asUser(userB);
    const res = await c.call("attach_file", {
      fileName: "big.pdf",
      mimeType: "application/pdf",
      contentBase64: "A".repeat(7_000_001),
    });
    expect(res.isError).toBe(true);
    await c.close();
  });

  it("has no file-count or size quota any more (D-013, replaces the AC-38 quota)", async () => {
    const userC = await seedUser("quota@example.com");
    const dir = cockpitUserDir(userC);
    fs.mkdirSync(dir, { recursive: true });
    const c = await asUser(userC);
    const args = {
      fileName: "q.pdf",
      mimeType: "application/pdf",
      contentBase64: pdfBase64(),
    };

    // No quota (D-013): 500 MB (sparse) and 250 files already stored, still accepted.
    const big = path.join(dir, "big.pdf");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 500 * 1024 * 1024);
    for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(dir, `${i}.pdf`), "%PDF");
    expect((await c.call("attach_file", args)).isError).toBe(false);
    await c.close();
  });

  it("removes old unreferenced uploads on the next attach_file and keeps everything in use (D-013)", async () => {
    const userD = await seedUser("cleanup@example.com");
    const dir = cockpitUserDir(userD);
    const c = await asUser(userD);
    const upload = async (name: string) => {
      const res = await c.call("attach_file", {
        fileName: name,
        mimeType: "application/pdf",
        contentBase64: pdfBase64(name),
      });
      const id = JSON.parse(res.text).fileId as string;
      const row = await prisma.file.findUniqueOrThrow({ where: { id } });
      return { id, filePath: row.filePath };
    };
    const age = (p: string, days: number) => {
      const t = new Date(Date.now() - days * 86_400_000);
      fs.utimesSync(p, t, t);
    };

    const orphanOld = await upload("orphan-old");
    const orphanNew = await upload("orphan-new");
    const used = await upload("used");
    const jobId = await newJob(userD);
    expect(
      (await c.call("submit_application_package", submitArgs(jobId, { cvFileId: used.id })))
        .isError,
    ).toBe(false);
    const stray = path.join(dir, "stray.pdf"); // a file with no row at all
    fs.writeFileSync(stray, "%PDF");
    age(orphanOld.filePath, 10);
    age(used.filePath, 10);
    age(stray, 10);
    age(orphanNew.filePath, 2);

    expect((await c.call("attach_file", {
      fileName: "next.pdf",
      mimeType: "application/pdf",
      contentBase64: pdfBase64("next"),
    })).isError).toBe(false);

    expect(fs.existsSync(orphanOld.filePath)).toBe(false);
    expect(await prisma.file.findUnique({ where: { id: orphanOld.id } })).toBeNull();
    expect(fs.existsSync(stray)).toBe(false);
    // Recent orphan (a submit may still follow) and a file a package uses stay.
    expect(fs.existsSync(orphanNew.filePath)).toBe(true);
    expect(fs.existsSync(used.filePath)).toBe(true);
    expect(await prisma.file.findUnique({ where: { id: used.id } })).not.toBeNull();
    await c.close();
  });

  it("scopes files to the user: another user's fileId is FILE_NOT_FOUND (AC-06)", async () => {
    const a = await asUser(userA);
    const b = await asUser(userB);
    const att = await b.call("attach_file", {
      fileName: "b.pdf",
      mimeType: "application/pdf",
      contentBase64: pdfBase64("b"),
    });
    const fileId = JSON.parse(att.text).fileId;
    const jobId = await newJob(userA);
    expect(
      await a.call("submit_application_package", submitArgs(jobId, { cvFileId: fileId })),
    ).toEqual({ isError: true, text: errorText("FILE_NOT_FOUND") });
    await a.close();
    await b.close();
  });

  it("maps domain errors to '<CODE>: <fixed message>' (AC-46)", async () => {
    const c = await asUser(userA);

    // NOT_FOUND: another user's job.
    const foreign = await newJob(userB);
    expect(await c.call("submit_application_package", submitArgs(foreign))).toEqual({
      isError: true,
      text: errorText("NOT_FOUND"),
    });

    // JOB_REJECTED
    const rejectedJob = await newJob(userA);
    await prisma.applicationPackage.create({
      data: {
        userId: userA,
        jobId: rejectedJob,
        version: 1,
        status: "rejected",
        emailSubject: "s",
        emailBody: "b",
      },
    });
    expect(await c.call("submit_application_package", submitArgs(rejectedJob))).toEqual({
      isError: true,
      text: errorText("JOB_REJECTED"),
    });

    // ALREADY_SENT
    const sentJob = await newJob(userA);
    await prisma.applicationPackage.create({
      data: {
        userId: userA,
        jobId: sentJob,
        version: 1,
        status: "sent",
        emailSubject: "s",
        emailBody: "b",
      },
    });
    expect(await c.call("submit_application_package", submitArgs(sentJob))).toEqual({
      isError: true,
      text: errorText("ALREADY_SENT"),
    });

    // CONFLICT: the same idempotency key on another job.
    const j1 = await newJob(userA);
    const j2 = await newJob(userA);
    await c.call("submit_application_package", submitArgs(j1, { idempotencyKey: "dup" }));
    expect(
      await c.call("submit_application_package", submitArgs(j2, { idempotencyKey: "dup" })),
    ).toEqual({ isError: true, text: errorText("CONFLICT") });

    // Shape violation: an error result, text not asserted (SDK message).
    expect((await c.call("submit_application_package", submitArgs(j1, { fitGrade: "Z" }))).isError).toBe(true);
    await c.close();
  });
});

describe("list_jobs / get_job (AC-11)", () => {
  it("returns only the token user's jobs, with the active package", async () => {
    const u = await seedUser("lister@example.com");
    const other = await seedUser("other@example.com");
    const withPkg = await newJob(u);
    const without = await newJob(u);
    await newJob(other);
    const c = await asUser(u);

    await c.call("submit_application_package", submitArgs(withPkg));
    const v2 = JSON.parse(
      (await c.call("submit_application_package", submitArgs(withPkg))).text,
    );

    const all = JSON.parse((await c.call("list_jobs", {})).text);
    expect(all.total).toBe(2);
    expect(all.jobs.map((j: { id: string }) => j.id).sort()).toEqual(
      [withPkg, without].sort(),
    );
    const row = all.jobs.find((j: { id: string }) => j.id === withPkg);
    expect(row).toMatchObject({
      title: "Engineer",
      company: "Example Corp",
      status: "draft",
      activePackage: { id: v2.packageId, version: 2, status: "pending" },
    });
    expect(all.jobs.find((j: { id: string }) => j.id === without).activePackage).toBeNull();

    const has = JSON.parse((await c.call("list_jobs", { hasPackage: true })).text);
    expect(has.jobs.map((j: { id: string }) => j.id)).toEqual([withPkg]);
    const none = JSON.parse((await c.call("list_jobs", { hasPackage: false })).text);
    expect(none.jobs.map((j: { id: string }) => j.id)).toEqual([without]);
    const byStatus = JSON.parse((await c.call("list_jobs", { status: "nope" })).text);
    expect(byStatus).toEqual({ total: 0, jobs: [] });
    const page = JSON.parse((await c.call("list_jobs", { limit: 1, offset: 1 })).text);
    expect(page.total).toBe(2);
    expect(page.jobs).toHaveLength(1);
    await c.close();
  });

  it("get_job returns the documented fields and all versions newest first", async () => {
    const c = await asUser(userA);
    const jobId = await newJob(userA, { jobUrl: "https://example.com/jobs/1", matchScore: 77 });
    await c.call("submit_application_package", submitArgs(jobId));
    await c.call("submit_application_package", submitArgs(jobId));

    const got = JSON.parse((await c.call("get_job", { jobId })).text);
    expect(got).toMatchObject({
      id: jobId,
      title: "Engineer",
      company: "Example Corp",
      location: null,
      status: "draft",
      jobUrl: "https://example.com/jobs/1",
      description: "A synthetic job",
      matchScore: 77,
      applied: false,
      appliedDate: null,
    });
    expect(got.packages.map((p: { version: number }) => p.version)).toEqual([2, 1]);
    expect(got.packages[1].status).toBe("superseded");
    await c.close();
  });

  it("get_job on another user's job is NOT_FOUND (user scoping)", async () => {
    const c = await asUser(userA);
    const foreign = await newJob(userB);
    expect(await c.call("get_job", { jobId: foreign })).toEqual({
      isError: true,
      text: errorText("NOT_FOUND"),
    });
    expect(await c.call("get_job", { jobId: "missing" })).toEqual({
      isError: true,
      text: errorText("NOT_FOUND"),
    });
    await c.close();
  });
});

describe("change requests (AC-11, AC-12)", () => {
  it("lists only the user's changes_requested packages, oldest first", async () => {
    const u = await seedUser("changes@example.com");
    const other = await seedUser("changes-other@example.com");
    const mk = async (userId: string, status: string, at: Date | null) => {
      const jobId = await newJob(userId);
      return prisma.applicationPackage.create({
        data: {
          userId,
          jobId,
          version: 1,
          status,
          changeRequest: "Shorten the letter",
          changeRequestedAt: at,
          emailSubject: "s",
          emailBody: "b",
        },
      });
    };
    const newer = await mk(u, "changes_requested", new Date("2026-02-01"));
    const older = await mk(u, "changes_requested", new Date("2026-01-01"));
    await mk(u, "pending", null);
    await mk(other, "changes_requested", new Date("2026-01-15"));

    const c = await asUser(u);
    const list = JSON.parse((await c.call("list_change_requests", {})).text);
    expect(list.map((r: { packageId: string }) => r.packageId)).toEqual([older.id, newer.id]);
    expect(list[0]).toMatchObject({
      jobTitle: "Engineer",
      company: "Example Corp",
      version: 1,
      changeRequest: "Shorten the letter",
      emailTo: null,
      emailSubject: "s",
      emailBody: "b",
      letterMd: null,
      cvJson: null,
      fitAnalysis: null,
      sourceFolder: null,
    });
    expect(
      JSON.parse((await c.call("list_change_requests", { limit: 1 })).text),
    ).toHaveLength(1);
    await c.close();
  });

  it("mark_change_request_done: changes_requested → pending, history kept; else INVALID_STATE / NOT_FOUND", async () => {
    const c = await asUser(userA);
    const jobId = await newJob(userA);
    const pkg = await prisma.applicationPackage.create({
      data: {
        userId: userA,
        jobId,
        version: 1,
        status: "changes_requested",
        changeRequest: "Fix the date",
        changeRequestedAt: new Date(),
        emailSubject: "s",
        emailBody: "b",
      },
    });

    const res = await c.call("mark_change_request_done", {
      packageId: pkg.id,
      response: "Done",
    });
    expect(JSON.parse(res.text)).toEqual({ packageId: pkg.id, status: "pending" });
    expect(await prisma.applicationPackage.findUniqueOrThrow({ where: { id: pkg.id } })).toMatchObject({
      status: "pending",
      changeRequest: "Fix the date",
      changeRequestResponse: "Done",
    });

    // Now pending: not allowed again.
    expect(
      await c.call("mark_change_request_done", { packageId: pkg.id, response: "Again" }),
    ).toEqual({ isError: true, text: errorText("INVALID_STATE") });

    // Another user's package.
    const foreign = await prisma.applicationPackage.create({
      data: {
        userId: userB,
        jobId: await newJob(userB),
        version: 1,
        status: "changes_requested",
        emailSubject: "s",
        emailBody: "b",
      },
    });
    expect(
      await c.call("mark_change_request_done", { packageId: foreign.id, response: "x" }),
    ).toEqual({ isError: true, text: errorText("NOT_FOUND") });
    await c.close();
  });
});
