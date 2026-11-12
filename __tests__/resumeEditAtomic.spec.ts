// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";

// Issue #63 (D-029), leftovers of PR #84: editResumeWith reads the old file
// from the resume itself and writes conditionally, so parallel edits and an
// edit without fileId leave no orphan File row or file. createResumeProfileWith
// names the right failure when the resume exists. Real SQLite, real temp dir.

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

import { createResumeProfileWith, editResumeWith } from "@/actions/profile/resumeWrite";

const prisma = db.prisma;
let tmp: string;
let resumes: string;
let userId: string;

const makeFile = (name: string) => {
  const filePath = path.join(resumes, `${crypto.randomUUID()}-${name}`);
  fs.writeFileSync(filePath, "%PDF-1.4 synthetic");
  return { fileName: name, filePath };
};

async function resumeWithFile() {
  const profile =
    (await prisma.profile.findFirst({ where: { userId } })) ??
    (await prisma.profile.create({ data: { userId } }));
  const up = makeFile("old.pdf");
  const file = await prisma.file.create({
    data: { fileName: up.fileName, filePath: up.filePath, fileType: "resume" },
  });
  const resume = await prisma.resume.create({
    data: { profileId: profile.id, title: `R ${file.id}`, FileId: file.id },
  });
  return { resumeId: resume.id, fileId: file.id, oldPath: up.filePath };
}

const resumeFileRows = () => prisma.file.findMany({ where: { fileType: "resume" } });

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resume-edit-")));
  state.uploads = path.join(tmp, "uploads");
  resumes = path.join(state.uploads, "files", "resumes");
  fs.mkdirSync(resumes, { recursive: true });
  userId = (await prisma.user.create({ data: { name: "A", email: "a@example.com", password: "x" } })).id;
  state.userId = userId;
}, 120_000);
afterAll(async () => {
  await db.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

describe("editResumeWith: the old file comes from the resume", () => {
  it("an upload without fileId removes the old File row and file", async () => {
    const { resumeId, fileId, oldPath } = await resumeWithFile();
    const up = makeFile("new.pdf");
    const res = await editResumeWith(resumeId, "T", undefined, up);
    expect(res.success).toBe(true);
    expect(await prisma.file.findUnique({ where: { id: fileId } })).toBeNull();
    expect(fs.existsSync(oldPath)).toBe(false);
    const after = await prisma.resume.findUnique({ where: { id: resumeId }, include: { File: true } });
    expect(after?.File?.filePath).toBe(up.filePath);
    expect(fs.existsSync(up.filePath)).toBe(true);
  });

  it("a title-only edit without fileId keeps the resume's file", async () => {
    const { resumeId, fileId, oldPath } = await resumeWithFile();
    const res = await editResumeWith(resumeId, "Renamed");
    expect(res.success).toBe(true);
    const after = await prisma.resume.findUnique({ where: { id: resumeId } });
    expect(after).toMatchObject({ title: "Renamed", FileId: fileId });
    expect(fs.existsSync(oldPath)).toBe(true);
  });

  it("parallel edits of one resume leave exactly one File row for it and no orphan", async () => {
    const { resumeId, fileId } = await resumeWithFile();
    const before = (await resumeFileRows()).length;
    const a = makeFile("a.pdf");
    const b = makeFile("b.pdf");
    const [ra, rb] = await Promise.all([
      editResumeWith(resumeId, "A", fileId, a),
      editResumeWith(resumeId, "B", fileId, b),
    ]);
    // Never both: the loser holds a stale fileId (or loses the conditional write).
    expect([ra.success, rb.success].filter(Boolean)).toHaveLength(1);
    expect((await resumeFileRows()).length).toBe(before);
    const resume = await prisma.resume.findUnique({ where: { id: resumeId }, include: { File: true } });
    expect(resume?.File).not.toBeNull();
    expect(await prisma.file.findUnique({ where: { id: fileId } })).toBeNull();
  });

  it("parallel edits without fileId leave no orphan File row", async () => {
    const { resumeId } = await resumeWithFile();
    const before = (await resumeFileRows()).length;
    const rs = await Promise.all([
      editResumeWith(resumeId, "A", undefined, makeFile("a.pdf")),
      editResumeWith(resumeId, "B", undefined, makeFile("b.pdf")),
    ]);
    expect(rs.some((r) => r.success)).toBe(true);
    expect((await resumeFileRows()).length).toBe(before);
    const linked = await prisma.file.count({ where: { fileType: "resume", Resume: { isNot: null } } });
    expect(linked).toBe(before);
  });

  it("a stale fileId is refused and nothing changes", async () => {
    const { resumeId, fileId } = await resumeWithFile();
    const up = makeFile("new.pdf");
    expect((await editResumeWith(resumeId, "T", undefined, up)).success).toBe(true);
    const stale = await editResumeWith(resumeId, "U", fileId, makeFile("x.pdf"));
    expect(stale.success).toBe(false);
  });
});

describe("createResumeProfileWith", () => {
  it("says the resume was created when only setting the default failed", async () => {
    const other = (await prisma.user.create({ data: { name: "B", email: "b@example.com", password: "x" } })).id;
    state.userId = other;
    vi.spyOn(prisma.user, "update").mockRejectedValueOnce(new Error("boom"));
    const res = await createResumeProfileWith("First");
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/created/i);
    expect(res.message).not.toBe("Failed to create resume.");
    expect(res.created).toBe(true);
    expect(await prisma.resume.count({ where: { profile: { userId: other } } })).toBe(1);
    state.userId = userId;
  });

  it("keeps the plain message when no resume was created", async () => {
    vi.spyOn(prisma.profile, "findFirst").mockRejectedValueOnce(new Error("boom"));
    const res = await createResumeProfileWith("Second");
    expect(res).toEqual({ success: false, message: "Failed to create resume." });
    expect(res.created).toBeUndefined();
  });
});
