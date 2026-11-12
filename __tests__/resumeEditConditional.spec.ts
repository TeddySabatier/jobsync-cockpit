// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";

// Issue #63 review: the conditional write of editResumeWith
// (updateMany ... FileId = the file it read) has no direct test in
// resumeEditAtomic.spec.ts, because Prisma serialises SQLite transactions and
// the parallel tests end in the "stale fileId" branch. Here a SQL trigger on
// the File insert changes the resume link INSIDE the editing transaction,
// i.e. after the read and before the conditional write: a competing commit.

const db = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("./cockpit/helpers/sqlite");
  return createCockpitTestDb();
});
const state = vi.hoisted(() => ({ uploads: "", userId: "" }));

vi.mock("@/lib/db", () => ({ default: db.prisma }));
vi.mock("@/lib/constants", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/constants")>();
  return {
    ...mod,
    APP_CONSTANTS: {
      ...mod.APP_CONSTANTS,
      get UPLOADS_DIR() {
        return state.uploads;
      },
    },
  };
});

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(async () => ({ id: state.userId })),
}));

import { editResumeWith } from "@/actions/profile/resumeWrite";

const prisma = db.prisma;
let tmp: string;
let resumes: string;
let userA: string;
let userB: string;

const makeFile = (name: string) => {
  const filePath = path.join(resumes, `${crypto.randomUUID()}-${name}`);
  fs.writeFileSync(filePath, "%PDF-1.4 synthetic");
  return { fileName: name, filePath };
};
async function fileRow(name: string) {
  const up = makeFile(name);
  const file = await prisma.file.create({
    data: { fileName: name, filePath: up.filePath, fileType: "resume" },
  });
  return { id: file.id, path: up.filePath };
}
async function resumeFor(owner: string, withFile: boolean) {
  const profile =
    (await prisma.profile.findFirst({ where: { userId: owner } })) ??
    (await prisma.profile.create({ data: { userId: owner } }));
  const f = withFile ? await fileRow("old.pdf") : null;
  const resume = await prisma.resume.create({
    data: { profileId: profile.id, title: `R-${crypto.randomUUID()}`, FileId: f?.id ?? null },
  });
  return { resumeId: resume.id, file: f, title: resume.title };
}
const fileCount = () => prisma.file.count();
const asUser = (id: string) => (state.userId = id);

// Competing write: when the edit inserts its new File row (named `marker`),
// point the resume at `competitorFileId` first, as another request would.
async function raceOnInsert(marker: string, resumeId: string, competitorFileId: string) {
  const name = `race_${marker.replace(/\W/g, "")}`;
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${name} AFTER INSERT ON "File" WHEN NEW."fileName" = '${marker}' ` +
      `BEGIN UPDATE "Resume" SET "FileId" = '${competitorFileId}', "title" = 'COMPETITOR' WHERE "id" = '${resumeId}'; END;`,
  );
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resume-cond-")));
  state.uploads = path.join(tmp, "uploads");
  resumes = path.join(state.uploads, "files", "resumes");
  fs.mkdirSync(resumes, { recursive: true });
  userA = (await prisma.user.create({ data: { name: "A", email: "a@example.com", password: "x" } })).id;
  userB = (await prisma.user.create({ data: { name: "B", email: "b@example.com", password: "x" } })).id;
}, 120_000);
afterAll(async () => {
  await db.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  asUser(userA);
});

describe("editResumeWith: conditional write against a competing commit", () => {
  it("loses cleanly: ResumeChangedError, new File row rolled back, old file untouched", async () => {
    const { resumeId, file: old, title } = await resumeFor(userA, true);
    const competitor = await fileRow("competitor.pdf");
    await raceOnInsert("race-new.pdf", resumeId, competitor.id);
    const before = await fileCount();
    const up = makeFile("race-new.pdf");

    const res = await editResumeWith(resumeId, "MINE", old!.id, up);

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/changed by another request/i);
    expect(await fileCount()).toBe(before); // the new File row rolled back
    expect(await prisma.file.findFirst({ where: { filePath: up.filePath } })).toBeNull();
    const after = await prisma.resume.findUniqueOrThrow({ where: { id: resumeId } });
    // The trigger ran inside the rolled-back transaction too.
    expect(after).toMatchObject({ FileId: old!.id, title });
    expect(fs.existsSync(old!.path)).toBe(true);
    expect(fs.existsSync(competitor.path)).toBe(true);
    expect(await prisma.file.findUnique({ where: { id: old!.id } })).not.toBeNull();
    // The upload stays on disk: the route discards it, not this function.
    expect(fs.existsSync(up.filePath)).toBe(true);
  });

  it("same race without fileId (upload only): also refused, nothing deleted", async () => {
    const { resumeId, file: old } = await resumeFor(userA, true);
    const competitor = await fileRow("competitor2.pdf");
    await raceOnInsert("race-new2.pdf", resumeId, competitor.id);
    const before = await fileCount();
    const res = await editResumeWith(resumeId, "MINE", undefined, makeFile("race-new2.pdf"));
    expect(res.success).toBe(false);
    expect(await fileCount()).toBe(before);
    expect(fs.existsSync(old!.path)).toBe(true);
    expect((await prisma.resume.findUniqueOrThrow({ where: { id: resumeId } })).FileId).toBe(old!.id);
  });

  it("resume without a file (FileId NULL): upload succeeds, and a race on NULL is still detected", async () => {
    const plain = await resumeFor(userA, false);
    const ok = await editResumeWith(plain.resumeId, "T", undefined, makeFile("fresh.pdf"));
    expect(ok.success).toBe(true);
    expect((await prisma.resume.findUniqueOrThrow({ where: { id: plain.resumeId } })).FileId).not.toBeNull();

    const raced = await resumeFor(userA, false);
    const competitor = await fileRow("competitor3.pdf");
    await raceOnInsert("race-null.pdf", raced.resumeId, competitor.id);
    const before = await fileCount();
    const res = await editResumeWith(raced.resumeId, "T", undefined, makeFile("race-null.pdf"));
    expect(res.success).toBe(false);
    expect(await fileCount()).toBe(before);
    expect((await prisma.resume.findUniqueOrThrow({ where: { id: raced.resumeId } })).FileId).toBeNull();
    expect(fs.existsSync(competitor.path)).toBe(true);
  });
});

describe("editResumeWith: ownership and ids", () => {
  it("another user's resume: refused, no File row created, nothing deleted", async () => {
    const { resumeId, file } = await resumeFor(userA, true);
    asUser(userB);
    const before = await fileCount();
    for (const fid of [file!.id, undefined]) {
      const res = await editResumeWith(resumeId, "HACK", fid, makeFile("evil.pdf"));
      expect(res.success).toBe(false);
    }
    expect(await fileCount()).toBe(before);
    expect(fs.existsSync(file!.path)).toBe(true);
    expect((await prisma.resume.findUniqueOrThrow({ where: { id: resumeId } })).FileId).toBe(file!.id);
  });

  it("a fileId that is not this resume's current file is refused, same message for every cause", async () => {
    const mine = await resumeFor(userA, true);
    const theirs = await resumeFor(userB, true);
    const mineOther = await resumeFor(userA, true);
    const msgs = new Set<string>();
    for (const fid of [theirs.file!.id, mineOther.file!.id, "does-not-exist"]) {
      const res = await editResumeWith(mine.resumeId, "X", fid, makeFile("n.pdf"));
      expect(res.success).toBe(false);
      msgs.add(res.message);
    }
    msgs.add((await editResumeWith("no-such-resume", "X", "no-such-file")).message);
    expect(msgs.size).toBe(1);
    expect(fs.existsSync(theirs.file!.path) && fs.existsSync(mineOther.file!.path)).toBe(true);
    expect((await prisma.resume.findUniqueOrThrow({ where: { id: mine.resumeId } })).FileId).toBe(mine.file!.id);
  });

  it("fileId without an upload keeps the file; no fileId and no upload keeps it too (D-029 g)", async () => {
    const r = await resumeFor(userA, true);
    expect((await editResumeWith(r.resumeId, "T1", r.file!.id)).success).toBe(true);
    expect((await editResumeWith(r.resumeId, "T2")).success).toBe(true);
    expect(await prisma.resume.findUniqueOrThrow({ where: { id: r.resumeId } })).toMatchObject({
      title: "T2",
      FileId: r.file!.id,
    });
    expect(fs.existsSync(r.file!.path)).toBe(true);
  });

  it("a replaced file referenced by a package: cvFileId becomes null (SetNull), nothing throws", async () => {
    const r = await resumeFor(userA, true);
    const st = await prisma.jobStatus.create({ data: { label: "S", value: `s-${r.resumeId}` } });
    const jt = await prisma.jobTitle.create({ data: { label: "T", value: `t-${r.resumeId}`, createdBy: userA } });
    const co = await prisma.company.create({ data: { label: "C", value: `c-${r.resumeId}`, createdBy: userA } });
    const job = await prisma.job.create({
      data: {
        userId: userA,
        description: "d",
        jobType: "FT",
        createdAt: new Date(),
        statusId: st.id,
        jobTitleId: jt.id,
        companyId: co.id,
      },
    });
    const pkg = await prisma.applicationPackage.create({
      data: { userId: userA, jobId: job.id, version: 1, emailSubject: "s", emailBody: "b", cvFileId: r.file!.id },
    });
    const res = await editResumeWith(r.resumeId, "N", r.file!.id, makeFile("n.pdf"));
    expect(res.success).toBe(true);
    expect((await prisma.applicationPackage.findUniqueOrThrow({ where: { id: pkg.id } })).cvFileId).toBeNull();
  });
});
