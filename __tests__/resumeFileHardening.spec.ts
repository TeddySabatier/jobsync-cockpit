// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";

// Issue #78 (D-024), same class as the download route: deleteFile and the AI
// resume import used the stored File.filePath without realpath confinement.
// Real SQLite (migrated temp DB), real temp dirs and symlinks, synthetic data.

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
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: state.userId } })),
}));
vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(async () => ({ id: state.userId })),
}));
vi.mock("@/lib/ai/rate-limiter", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, resetIn: 0 })),
}));
// The import stops at text extraction: the test only needs to know which
// bytes were read (a failure result ends the request with 422 before any model).
const extracted = vi.hoisted(() => ({ bufs: [] as Buffer[] }));
vi.mock("@/lib/ai/import/extract-text", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/ai/import/extract-text")>();
  return {
    ...mod,
    extractText: vi.fn(async (buf: Buffer) => {
      extracted.bufs.push(Buffer.from(buf));
      return { success: false, error: { message: "stop", code: "TEST_STOP" } };
    }),
  };
});

import { deleteFile } from "@/actions/profile/files";
import { POST as importResume } from "@/app/api/ai/resume/import/route";
import { POST as uploadResume } from "@/app/api/profile/resume/route";
import * as profileActions from "@/actions/profile.actions";
import { createResumeProfile, editResume } from "@/actions/profile/resume";
import { log } from "@/lib/telemetry";

const prisma = db.prisma;
const PDF = Buffer.from("%PDF-1.4\n% synthetic resume\n%%EOF\n");
const SECRET = Buffer.from("%PDF-1.4 SECRET-OUTSIDE-UPLOADS");

let tmp: string;
let resumes: string;
let userA: string;
let userB: string;

const write = (p: string, body: Buffer = PDF) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};
const fresh = (dir: string) => path.join(dir, `${crypto.randomUUID()}.pdf`);

// A resume of `userId` whose File row stores `filePath` as is.
async function resumeWithFile(userId: string, filePath: string) {
  const profile =
    (await prisma.profile.findFirst({ where: { userId } })) ??
    (await prisma.profile.create({ data: { userId } }));
  const file = await prisma.file.create({
    data: { fileName: "cv.pdf", filePath, fileType: "application/pdf" },
  });
  const resume = await prisma.resume.create({
    data: { profileId: profile.id, title: "CV", FileId: file.id },
  });
  return { fileId: file.id, resumeId: resume.id };
}

const fileRow = (id: string) => prisma.file.findUnique({ where: { id } });

const callImport = (resumeId: string) =>
  importResume(
    new NextRequest("http://localhost/api/ai/resume/import", {
      method: "POST",
      body: JSON.stringify({
        resumeId,
        selectedModel: { provider: "ollama", model: "test" },
      }),
    }),
  );

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resume-hard-")));
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
  state.userId = userA;
  extracted.bufs = [];
});
afterEach(() => vi.restoreAllMocks());

describe("deleteFile: only files inside the resumes dir are removed", () => {
  it("removes the user's own file and its row (normal case)", async () => {
    const p = write(fresh(resumes));
    const { fileId } = await resumeWithFile(userA, p);
    await deleteFile(fileId);
    expect(fs.existsSync(p)).toBe(false);
    expect(await fileRow(fileId)).toBeNull();
  });

  it("keeps a file outside the uploads dir (legacy row): row deleted, code-only warning", async () => {
    const outside = write(fresh(tmp), SECRET);
    const { fileId } = await resumeWithFile(userA, outside);
    const warn = vi.spyOn(log, "warn");
    await deleteFile(fileId);
    expect(fs.readFileSync(outside)).toEqual(SECRET);
    expect(await fileRow(fileId)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.any(String), { code: "FILE_OUTSIDE_UPLOADS" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(outside);
  });

  it("keeps a file reached through '..' out of the resumes dir", async () => {
    const outside = write(path.join(tmp, "dotdot.pdf"), SECRET);
    const { fileId } = await resumeWithFile(userA, `${resumes}/../../../dotdot.pdf`);
    await deleteFile(fileId);
    expect(fs.readFileSync(outside)).toEqual(SECRET);
  });

  it("keeps a file inside uploads but outside the resumes dir", async () => {
    const other = write(fresh(path.join(state.uploads, "files", "cockpit", userB)), SECRET);
    const { fileId } = await resumeWithFile(userA, other);
    await deleteFile(fileId);
    expect(fs.readFileSync(other)).toEqual(SECRET);
  });

  it("does not follow a symlink out of the resumes dir", async () => {
    const target = write(fresh(tmp), SECRET);
    const link = fresh(resumes);
    fs.symlinkSync(target, link);
    const { fileId } = await resumeWithFile(userA, link);
    await deleteFile(fileId);
    expect(fs.readFileSync(target)).toEqual(SECRET);
    expect(await fileRow(fileId)).toBeNull();
  });

  it("does not delete another user's file through a symlink that stays inside the resumes dir", async () => {
    const theirs = write(fresh(resumes), SECRET);
    await resumeWithFile(userB, theirs);
    const link = fresh(resumes);
    fs.symlinkSync(theirs, link);
    const { fileId } = await resumeWithFile(userA, link);
    await deleteFile(fileId);
    expect(fs.readFileSync(theirs)).toEqual(SECRET);
    expect(await fileRow(fileId)).toBeNull();
  });

  it("refuses another user's file id and leaves file and row alone", async () => {
    const p = write(fresh(resumes));
    const { fileId } = await resumeWithFile(userB, p);
    await expect(deleteFile(fileId)).rejects.toThrow("File not found or access denied");
    expect(fs.existsSync(p)).toBe(true);
    expect(await fileRow(fileId)).not.toBeNull();
  });

  it("deletes the row when the file is already gone, without a warning", async () => {
    const { fileId } = await resumeWithFile(userA, fresh(resumes));
    const warn = vi.spyOn(log, "warn");
    await deleteFile(fileId);
    expect(await fileRow(fileId)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/resume/import: the stored file is realpath-confined", () => {
  it("reads the user's own resume file (normal case)", async () => {
    const { resumeId } = await resumeWithFile(userA, write(fresh(resumes)));
    const res = await callImport(resumeId);
    expect(res.status).toBe(422); // stopped by the extract-text mock, after the read
    expect(extracted.bufs).toEqual([PDF]);
  });

  it("refuses a symlink inside the resumes dir that points out", async () => {
    const target = write(fresh(tmp), SECRET);
    const link = fresh(resumes);
    fs.symlinkSync(target, link);
    const { resumeId } = await resumeWithFile(userA, link);
    const res = await callImport(resumeId);
    expect(res.status).toBe(400);
    expect(extracted.bufs).toEqual([]);
  });

  it("refuses a directory symlink inside the resumes dir that points out", async () => {
    const outDir = path.join(tmp, `out-${crypto.randomUUID()}`);
    write(path.join(outDir, "cv.pdf"), SECRET);
    const linkDir = path.join(resumes, `dir-${crypto.randomUUID()}`);
    fs.symlinkSync(outDir, linkDir);
    const { resumeId } = await resumeWithFile(userA, path.join(linkDir, "cv.pdf"));
    expect((await callImport(resumeId)).status).toBe(400);
    expect(extracted.bufs).toEqual([]);
  });

  it("refuses a legacy row pointing outside the uploads dir", async () => {
    const { resumeId } = await resumeWithFile(userA, write(fresh(tmp), SECRET));
    expect((await callImport(resumeId)).status).toBe(400);
    expect(extracted.bufs).toEqual([]);
  });

  it("refuses another user's resume", async () => {
    const { resumeId } = await resumeWithFile(userB, write(fresh(resumes)));
    expect((await callImport(resumeId)).status).toBe(400);
    expect(extracted.bufs).toEqual([]);
  });

  it("answers the same message for a path outside and a missing file", async () => {
    const outside = await resumeWithFile(userA, write(fresh(tmp), SECRET));
    const missing = await resumeWithFile(userA, fresh(resumes));
    const a = await (await callImport(outside.resumeId)).json();
    const b = await (await callImport(missing.resumeId)).json();
    expect(a).toEqual(b);
  });
});

const upload = (fields: Record<string, string>, name = "cv.pdf", body: Buffer = PDF) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("file", new File([new Uint8Array(body)], name, { type: "application/pdf" }));
  return uploadResume(
    new NextRequest("http://localhost/api/profile/resume", { method: "POST", body: form }),
  );
};

const fileOf = async (resumeId: string) =>
  (await prisma.resume.findUnique({ where: { id: resumeId }, include: { File: true } }))!.File;

describe("POST /api/profile/resume: the server makes the stored path", () => {
  it("stores a new resume's upload inside the resumes dir (normal case)", async () => {
    const res = await upload({ title: `New ${crypto.randomUUID()}` });
    expect(res!.status).toBe(201);
    const { data } = await res!.json();
    const file = await fileOf(data.id);
    expect(path.dirname(path.resolve(file!.filePath))).toBe(resumes);
    expect(fs.readFileSync(file!.filePath)).toEqual(PDF);
    expect(file!.fileName).toBe("cv.pdf");
  });

  it("never overwrites an upload of the same name in the same second", async () => {
    const a = await (await upload({ title: `Twin ${crypto.randomUUID()}` }, "twin.pdf", PDF))!.json();
    const b = await (await upload({ title: `Twin ${crypto.randomUUID()}` }, "twin.pdf", SECRET))!.json();
    const fa = await fileOf(a.data.id);
    const fb = await fileOf(b.data.id);
    expect(fa!.filePath).not.toBe(fb!.filePath);
    expect(fs.readFileSync(fa!.filePath)).toEqual(PDF);
    expect(fs.readFileSync(fb!.filePath)).toEqual(SECRET);
  });

  it("keeps a hostile upload name inside the resumes dir", async () => {
    const res = await upload({ title: `Evil ${crypto.randomUUID()}` }, "../../../evil.pdf");
    const { data } = await res!.json();
    const file = await fileOf(data.id);
    expect(path.dirname(path.resolve(file!.filePath))).toBe(resumes);
    expect(fs.existsSync(path.join(tmp, "evil.pdf"))).toBe(false);
  });

  it("replaces the file of the user's own resume on edit", async () => {
    const old = write(fresh(resumes));
    const { fileId, resumeId } = await resumeWithFile(userA, old);
    const res = await upload({ id: resumeId, title: "Edited", fileId });
    expect(res!.status).toBe(200);
    const file = await fileOf(resumeId);
    expect(file!.id).not.toBe(fileId);
    expect(path.dirname(path.resolve(file!.filePath))).toBe(resumes);
    expect(fs.existsSync(old)).toBe(false);
    expect(await fileRow(fileId)).toBeNull();
  });

  const resumeFiles = () => fs.readdirSync(resumes).sort();

  it("a failed edit (another user's resume) keeps the old file and row and discards the new upload", async () => {
    const old = write(fresh(resumes));
    const mine = await resumeWithFile(userA, old);
    const theirs = await resumeWithFile(userB, write(fresh(resumes)));
    const before = resumeFiles();
    const filesBefore = await prisma.file.count();
    const res = await upload({ id: theirs.resumeId, title: "Hijack", fileId: mine.fileId });
    expect((await res!.json()).success).toBe(false);
    expect(fs.readFileSync(old)).toEqual(PDF);
    expect(await fileRow(mine.fileId)).not.toBeNull();
    expect((await fileOf(mine.resumeId))!.id).toBe(mine.fileId);
    expect(resumeFiles()).toEqual(before);
    expect(await prisma.file.count()).toBe(filesBefore);
  });

  it("a failed edit (file of another of the user's resumes) keeps that file", async () => {
    const old = write(fresh(resumes));
    const first = await resumeWithFile(userA, old);
    const second = await resumeWithFile(userA, write(fresh(resumes)));
    const before = resumeFiles();
    const res = await upload({ id: second.resumeId, title: "Swap", fileId: first.fileId });
    expect((await res!.json()).success).toBe(false);
    expect(fs.readFileSync(old)).toEqual(PDF);
    expect((await fileOf(first.resumeId))!.id).toBe(first.fileId);
    expect(resumeFiles()).toEqual(before);
  });

  it("a database failure answers the fixed message, never the error text with the stored path", async () => {
    const leak = (p: string) => new Error(`Unique constraint failed on filePath ${p}`);
    const before = resumeFiles();
    const create = vi
      .spyOn(prisma.file, "create")
      .mockImplementation((async (args: { data: { filePath: string } }) => {
        throw leak(args.data.filePath);
      }) as never);
    const created = await (await upload({ title: `Leak ${crypto.randomUUID()}` }))!.json();
    create.mockRestore();
    expect(created).toEqual({ success: false, message: "Failed to create resume." });
    expect(resumeFiles()).toEqual(before);

    const { fileId, resumeId } = await resumeWithFile(userA, write(fresh(resumes)));
    const before2 = resumeFiles();
    const tx = vi.spyOn(prisma, "$transaction").mockImplementation((async () => {
      throw leak(path.join(resumes, "x.pdf"));
    }) as never);
    const edited = await (await upload({ id: resumeId, title: "Leak", fileId }))!.json();
    tx.mockRestore();
    expect(edited).toEqual({ success: false, message: "Failed to update resume or file." });
    expect(JSON.stringify(edited)).not.toContain(tmp);
    expect(resumeFiles()).toEqual(before2);
    expect(await fileRow(fileId)).not.toBeNull();
  });

  it("answers a fixed 500 message without the error text (it can carry a path), code-only log", async () => {
    const saved = state.uploads;
    // UPLOADS_DIR is a regular file: mkdir fails with a message naming the path.
    const blocker = path.join(tmp, `blocker-${crypto.randomUUID()}`);
    fs.writeFileSync(blocker, "x");
    state.uploads = blocker;
    const err = vi.spyOn(log, "error");
    try {
      const res = await upload({ title: `Fail ${crypto.randomUUID()}` });
      expect(res!.status).toBe(500);
      const text = await res!.text();
      expect(JSON.parse(text)).toEqual({ error: "Resume update or File upload failed" });
      expect(text).not.toContain(tmp);
      expect(err).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: "RESUME_UPLOAD_FAILED" }),
      );
      expect(JSON.stringify(err.mock.calls)).not.toContain(tmp);
    } finally {
      state.uploads = saved;
    }
  });
});

describe("no exported action accepts a path", () => {
  it("the actions barrel no longer exports uploadFile", () => {
    expect((profileActions as Record<string, unknown>).uploadFile).toBeUndefined();
  });

  it("createResumeProfile ignores a file name and path passed by a caller", async () => {
    const outside = write(fresh(tmp), SECRET);
    const create = createResumeProfile as unknown as (...a: unknown[]) => Promise<{
      success: boolean;
      data: { id: string };
    }>;
    const res = await create(`Forged ${crypto.randomUUID()}`, "x.pdf", outside);
    expect(res.success).toBe(true);
    expect(await fileOf(res.data.id)).toBeNull();
    expect(await prisma.file.findFirst({ where: { filePath: outside } })).toBeNull();
  });

  it("editResume ignores a file name and path passed by a caller", async () => {
    const outside = write(fresh(tmp), SECRET);
    const { resumeId } = await resumeWithFile(userA, write(fresh(resumes)));
    await prisma.resume.update({ where: { id: resumeId }, data: { FileId: null } });
    const edit = editResume as unknown as (...a: unknown[]) => Promise<{ success: boolean }>;
    const res = await edit(resumeId, "Forged", undefined, "x.pdf", outside);
    expect(res.success).toBe(true);
    expect(await fileOf(resumeId)).toBeNull();
    expect(await prisma.file.findFirst({ where: { filePath: outside } })).toBeNull();
  });
});
