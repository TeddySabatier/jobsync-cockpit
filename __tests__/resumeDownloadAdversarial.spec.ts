// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { NextRequest } from "next/server";

// Issue #78 (D-024), adversarial review of the fix: attacks a signed-in user
// can make on the download route and on the File rows it trusts. Real SQLite
// (migrated temp DB), real temp dirs, symlinks and permissions, synthetic data.

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

import { GET, POST } from "@/app/api/profile/resume/route";
import { editResume } from "@/actions/profile/resume";
import { buildBackupZip } from "@/lib/backup/export";

const prisma = db.prisma;
const PDF = Buffer.from("%PDF-1.4\n% synthetic resume\n%%EOF\n");
const SECRET = Buffer.from("%PDF-1.4 SECRET-OF-ANOTHER-USER");

let tmp: string;
let realUploads: string;
let resumes: string;
let secret: string;
let userA: string;
let userB: string;
let statusId: string;

const write = (p: string, body: Buffer = PDF) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};
const fresh = (dir: string, ext = ".pdf") => path.join(dir, `${crypto.randomUUID()}${ext}`);
const cockpitDir = (userId: string) => path.join(state.uploads, "files", "cockpit", userId);

async function profileOf(userId: string) {
  return (
    (await prisma.profile.findFirst({ where: { userId } })) ??
    (await prisma.profile.create({ data: { userId } }))
  );
}

// A File row storing `filePath` as is, optionally the file of a new resume of
// `resumeOwner` and/or the CV of a new cockpit package of `packageOwner`.
async function fileRow(
  filePath: string,
  opts: { resumeOwner?: string; packageOwner?: string; fileName?: string } = {},
) {
  const file = await prisma.file.create({
    data: { fileName: opts.fileName ?? "Jane_Doe_CV.pdf", filePath, fileType: "application/pdf" },
  });
  let resumeId: string | undefined;
  if (opts.resumeOwner) {
    const profile = await profileOf(opts.resumeOwner);
    resumeId = (
      await prisma.resume.create({ data: { profileId: profile.id, title: `CV ${file.id}`, FileId: file.id } })
    ).id;
  }
  if (opts.packageOwner) {
    const userId = opts.packageOwner;
    const title = await prisma.jobTitle.create({
      data: { label: "Engineer", value: `eng-${crypto.randomUUID()}`, createdBy: userId },
    });
    const company = await prisma.company.create({
      data: { label: "Example Corp", value: `corp-${crypto.randomUUID()}`, createdBy: userId },
    });
    const job = await prisma.job.create({
      data: {
        userId,
        description: "A synthetic job",
        jobType: "FT",
        createdAt: new Date(),
        statusId,
        jobTitleId: title.id,
        companyId: company.id,
      },
    });
    await prisma.applicationPackage.create({
      data: { userId, jobId: job.id, version: 1, emailSubject: "Application", emailBody: "Hello", cvFileId: file.id },
    });
  }
  return { fileId: file.id, resumeId };
}

// A resume of `userId` without a file.
async function bareResume(userId: string) {
  const profile = await profileOf(userId);
  return (await prisma.resume.create({ data: { profileId: profile.id, title: `bare ${crypto.randomUUID()}` } })).id;
}

const get = (query: string, init?: RequestInit) =>
  GET(new NextRequest(`http://localhost/api/profile/resume?${query}`, init as never));
const byId = (id: string) => get(`fileId=${encodeURIComponent(id)}`);

async function expectHidden(res: Response | undefined) {
  expect(res!.status).toBe(404);
  expect(Buffer.from(await res!.arrayBuffer()).length).toBe(0);
}
async function expectServed(res: Response | undefined, body: Buffer = PDF) {
  expect(res!.status).toBe(200);
  expect(Buffer.from(await res!.arrayBuffer())).toEqual(body);
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resume-adv-")));
  realUploads = path.join(tmp, "uploads");
  state.uploads = realUploads;
  resumes = path.join(state.uploads, "files", "resumes");
  fs.mkdirSync(resumes, { recursive: true });
  secret = write(path.join(tmp, "secret.pdf"), SECRET);
  userA = (await prisma.user.create({ data: { name: "A", email: "a@example.com", password: "x" } })).id;
  userB = (await prisma.user.create({ data: { name: "B", email: "b@example.com", password: "x" } })).id;
  statusId = (await prisma.jobStatus.create({ data: { label: "Draft", value: "draft" } })).id;
}, 120_000);

afterAll(async () => {
  await db.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  state.userId = userA;
  state.uploads = realUploads;
  vi.stubEnv("COCKPIT_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a File row shared between a resume and a cockpit package", () => {
  it("a CV in A's cockpit dir that B's resume points to: A gets it, B does not", async () => {
    const p = write(fresh(cockpitDir(userA)), SECRET);
    const { fileId } = await fileRow(p, { resumeOwner: userB, packageOwner: userA });
    await expectServed(await byId(fileId), SECRET);
    state.userId = userB;
    await expectHidden(await byId(fileId));
  });

  it("a resume of B that is also a package CV of A: B gets it, A does not (wrong dir for a CV)", async () => {
    const p = write(fresh(resumes), SECRET);
    const { fileId } = await fileRow(p, { resumeOwner: userB, packageOwner: userA });
    await expectHidden(await byId(fileId));
    state.userId = userB;
    await expectServed(await byId(fileId), SECRET);
  });

  it("A's resume that is also A's package CV is served from the resumes dir", async () => {
    const { fileId } = await fileRow(write(fresh(resumes)), { resumeOwner: userA, packageOwner: userA });
    await expectServed(await byId(fileId));
  });
});

describe("file ids that are not exactly a File id", () => {
  it("answers 404 to a valid id with a NUL byte, whitespace, other case or Unicode look-alikes", async () => {
    const { fileId } = await fileRow(write(fresh(resumes)), { resumeOwner: userA });
    await expectServed(await byId(fileId));
    for (const id of [
      `${fileId}\u0000`,
      `${fileId}\u0000/../../secret.pdf`,
      ` ${fileId}`,
      `${fileId} `,
      fileId.toUpperCase(),
      fileId.replace(/-/g, "‐"),
      // Full-width look-alike of the first character (always differs).
      String.fromCharCode(fileId.charCodeAt(0) + 0xfee0) + fileId.slice(1),
      `${fileId}%`,
    ]) {
      await expectHidden(await byId(id));
    }
  });

  it("answers 404 to ids just over the length limit", async () => {
    await expectHidden(await byId("a".repeat(65)));
    await expectHidden(await byId("a".repeat(100_000)));
  });
});

describe("query string pollution", () => {
  it("only the first fileId counts, and a filePath next to it is never read", async () => {
    const own = (await fileRow(write(fresh(resumes)), { resumeOwner: userA })).fileId;
    const other = (await fileRow(write(fresh(resumes), SECRET), { resumeOwner: userB })).fileId;
    await expectHidden(await get(`fileId=${other}&fileId=${own}`));
    await expectServed(await get(`fileId=${own}&fileId=${other}`));
    await expectServed(await get(`filePath=${encodeURIComponent(secret)}&fileId=${own}`));
    await expectServed(await get(`fileId=${own}&filePath=${encodeURIComponent(secret)}`));
  });

  it("a Range header does not change what is served", async () => {
    const own = (await fileRow(write(fresh(resumes)), { resumeOwner: userA })).fileId;
    const res = await get(`fileId=${own}`, { headers: { Range: "bytes=0-3" } });
    await expectServed(res);
  });
});

describe("extensions and links inside the resumes dir", () => {
  it("serves an upper-case .PDF as a PDF", async () => {
    const { fileId } = await fileRow(write(fresh(resumes, ".PDF")), { resumeOwner: userA });
    const res = await byId(fileId);
    expect(res!.headers.get("Content-Type")).toBe("application/pdf");
    await expectServed(res);
  });

  it("answers 404 to .pdf.exe, .pdf. , no extension, .html and .svg", async () => {
    for (const ext of [".pdf.exe", ".pdf.", "", ".html", ".svg", ".pdf.txt"]) {
      const p = write(fresh(resumes, ext));
      await expectHidden(await byId((await fileRow(p, { resumeOwner: userA })).fileId));
    }
  });

  it("judges the type by the real target: a .pdf link to a .txt is refused, a .txt link to a .pdf is served", async () => {
    const txt = write(fresh(resumes, ".txt"), Buffer.from("not a resume"));
    const pdfLink = fresh(resumes);
    fs.symlinkSync(txt, pdfLink);
    await expectHidden(await byId((await fileRow(pdfLink, { resumeOwner: userA })).fileId));

    const target = write(fresh(resumes));
    const txtLink = fresh(resumes, ".txt");
    fs.symlinkSync(target, txtLink);
    await expectServed(await byId((await fileRow(txtLink, { resumeOwner: userA })).fileId));
  });

  it("answers 404 to a .docx symlink into another user's cockpit dir", async () => {
    const theirs = write(fresh(cockpitDir(userB)), SECRET);
    const link = fresh(resumes, ".docx");
    fs.symlinkSync(theirs, link);
    await expectHidden(await byId((await fileRow(link, { resumeOwner: userA })).fileId));
  });

  it("answers 404 to a path that differs from the resumes dir only by case", async () => {
    const p = write(fresh(resumes));
    const upper = p.replace(`${path.sep}resumes${path.sep}`, `${path.sep}RESUMES${path.sep}`);
    await expectHidden(await byId((await fileRow(upper, { resumeOwner: userA })).fileId));
  });
});

describe("the uploads dir itself behind a symlink (a mounted /data)", () => {
  it("serves files through the link and still refuses files outside the real dir", async () => {
    const link = path.join(tmp, `uploads-link-${crypto.randomUUID()}`);
    fs.symlinkSync(realUploads, link);
    state.uploads = link;
    const inside = write(path.join(link, "files", "resumes", `${crypto.randomUUID()}.pdf`));
    await expectServed(await byId((await fileRow(inside, { resumeOwner: userA })).fileId));
    // The same file stored by its real path is the same file.
    const real = fs.realpathSync(inside);
    await expectServed(await byId((await fileRow(real, { resumeOwner: userA })).fileId));
    await expectHidden(await byId((await fileRow(secret, { resumeOwner: userA })).fileId));
  });

  it("refuses everything when the resumes dir itself is a symlink out of the uploads dir", async () => {
    const uploads = path.join(tmp, `uploads-${crypto.randomUUID()}`);
    const elsewhere = path.join(tmp, `elsewhere-${crypto.randomUUID()}`);
    fs.mkdirSync(path.join(uploads, "files"), { recursive: true });
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(uploads, "files", "resumes"));
    state.uploads = uploads;
    const p = write(path.join(uploads, "files", "resumes", "cv.pdf"), SECRET);
    await expectHidden(await byId((await fileRow(p, { resumeOwner: userA })).fileId));
  });
});

describe("errors never carry the path", () => {
  it("an unreadable file answers a generic 500 without the path or the error text", async () => {
    if (process.getuid?.() === 0) return; // root reads mode 000 files
    const p = write(fresh(resumes));
    fs.chmodSync(p, 0o000);
    try {
      const { fileId } = await fileRow(p, { resumeOwner: userA });
      const res = await byId(fileId);
      expect(res!.status).toBe(500);
      const text = await res!.text();
      expect(text).toBe(JSON.stringify({ error: "File download failed" }));
      expect(text).not.toContain(tmp);
      expect(text).not.toContain("EACCES");
    } finally {
      fs.chmodSync(p, 0o644);
    }
  });

  it("a hostile display name cannot add a header or break out of the quotes", async () => {
    const { fileId } = await fileRow(write(fresh(resumes)), {
      resumeOwner: userA,
      fileName: 'cv.pdf"\r\nSet-Cookie: a=b; x=" \u0085.pdf',
    });
    const res = await byId(fileId);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Set-Cookie")).toBeNull();
    const cd = res!.headers.get("Content-Disposition")!;
    for (const c of ["\r", "\n", String.fromCharCode(0x2028), String.fromCharCode(0x85)]) {
      expect(cd.includes(c)).toBe(false);
    }
    // Exactly the two quotes around the ASCII name.
    expect(cd.split('"').length).toBe(3);
  });
});

describe("a resume cannot be pointed at a File it does not own (editResume)", () => {
  // Without this check, POST /api/profile/resume {id, title, fileId} links the
  // caller's resume to any File row by id (another user's cockpit CV, an
  // unlinked resume file). The download route then trusts that link, the
  // backup export reads the bytes without confinement, and deleteFile drops
  // the other user's row.
  const postForm = (fields: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return POST(new NextRequest("http://localhost/api/profile/resume", { method: "POST", body: form }));
  };

  it("refuses another user's cockpit CV id through the upload route", async () => {
    const marker = Buffer.from(`%PDF-1.4 ONLY-IN-A-COCKPIT-CV ${crypto.randomUUID()}`);
    const theirs = (await fileRow(write(fresh(cockpitDir(userA)), marker), { packageOwner: userA })).fileId;
    state.userId = userB;
    const mine = await bareResume(userB);
    const res = await postForm({ id: mine, title: "x", fileId: theirs });
    const body = await res!.json();
    expect(body.success).toBe(false);
    const after = await prisma.resume.findUnique({ where: { id: mine } });
    expect(after!.FileId).toBeNull();

    // Nor through the backup export.
    const zip = await JSZip.loadAsync((await buildBackupZip(userB, "b@example.com")).buffer);
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir) continue;
      const bytes = await zip.files[name].async("nodebuffer");
      expect(bytes.includes(marker)).toBe(false);
    }
  });

  it("refuses an unlinked resume file of another user, so it cannot be downloaded or deleted", async () => {
    const p = write(fresh(resumes), SECRET);
    const orphan = (await fileRow(p)).fileId;
    state.userId = userB;
    const mine = await bareResume(userB);
    const res = await editResume(mine, "x", orphan);
    expect(res.success).toBe(false);
    await expectHidden(await byId(orphan));
    expect(fs.existsSync(p)).toBe(true);
    expect(await prisma.file.findUnique({ where: { id: orphan } })).not.toBeNull();
  });

  it("refuses the file of another resume of the same user, and a missing id, with one message", async () => {
    const first = await fileRow(write(fresh(resumes)), { resumeOwner: userA });
    const second = await bareResume(userA);
    const taken = await editResume(second, "x", first.fileId);
    const missing = await editResume(second, "x", crypto.randomUUID());
    expect(taken.success).toBe(false);
    expect(missing.success).toBe(false);
    expect(taken.message).toBe(missing.message);
    expect(missing.message).not.toMatch(/[0-9a-f]{8}-/);
  });

  it("keeps the resume's own file on a title-only edit (normal case)", async () => {
    const { fileId, resumeId } = await fileRow(write(fresh(resumes)), { resumeOwner: userA });
    const res = await editResume(resumeId!, "Renamed", fileId);
    expect(res.success).toBe(true);
    const after = await prisma.resume.findUnique({ where: { id: resumeId } });
    expect(after).toMatchObject({ title: "Renamed", FileId: fileId });
  });

  it("refuses to edit another user's resume even with its own file id", async () => {
    const { fileId, resumeId } = await fileRow(write(fresh(resumes)), { resumeOwner: userA });
    state.userId = userB;
    const res = await editResume(resumeId!, "Hijacked", fileId);
    expect(res.success).toBe(false);
    const after = await prisma.resume.findUnique({ where: { id: resumeId } });
    expect(after!.title).not.toBe("Hijacked");
  });
});
