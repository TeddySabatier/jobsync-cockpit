// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";

// Issue #78 (D-024): GET /api/profile/resume used to read any path given in
// `?filePath=`. It now takes a File id, looks the row up for the signed-in
// user and confines the stored path to the uploads dir. Real SQLite (migrated
// temp DB), real temp dirs and symlinks, synthetic data only.

const db = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("./cockpit/helpers/sqlite");
  return createCockpitTestDb();
});
const state = vi.hoisted(() => ({ uploads: "" }));

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
vi.mock("@/auth", () => ({ auth: vi.fn() }));
// The POST half of the route (upload) is not under test here.
vi.mock("@/actions/profile.actions", () => ({
  createResumeProfile: vi.fn(),
  deleteFile: vi.fn(),
  editResume: vi.fn(),
  uploadFile: vi.fn(),
}));

import { auth } from "@/auth";
import * as route from "@/app/api/profile/resume/route";
import { authConfig } from "@/auth.config";
import { config as middlewareConfig } from "@/middleware";
import { resumeDetailInclude } from "@/lib/jobs/resumeDetailInclude";

const { GET } = route;
const prisma = db.prisma;
const authMock = auth as unknown as ReturnType<typeof vi.fn>;

const PDF = Buffer.from("%PDF-1.4\n% synthetic resume\n%%EOF\n");
const SECRET = Buffer.from("%PDF-1.4 SECRET-OUTSIDE-UPLOADS");

let tmp: string; // holds uploads/, uploads-evil/ and secrets next to them
let resumes: string;
let secret: string;
let userA: string;
let userB: string;
let statusId: string;

async function seedUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: { name: "Jane Doe", email, password: "x" },
  });
  return user.id;
}

// A resume of `userId` whose File row stores `filePath` as is.
async function resumeFile(
  userId: string,
  filePath: string,
  fileName = "Jane_Doe_CV.pdf",
): Promise<string> {
  const profile =
    (await prisma.profile.findFirst({ where: { userId } })) ??
    (await prisma.profile.create({ data: { userId } }));
  const file = await prisma.file.create({
    data: { fileName, filePath, fileType: "application/pdf" },
  });
  await prisma.resume.create({
    data: { profileId: profile.id, title: "CV", FileId: file.id },
  });
  return file.id;
}

// A cockpit package CV of `userId` whose File row stores `filePath`.
async function cockpitFile(userId: string, filePath: string): Promise<string> {
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
  const file = await prisma.file.create({
    data: { fileName: "Jane Doe CV.pdf", filePath, fileType: "application/pdf" },
  });
  await prisma.applicationPackage.create({
    data: {
      userId,
      jobId: job.id,
      version: 1,
      emailSubject: "Application",
      emailBody: "Hello",
      cvFileId: file.id,
    },
  });
  return file.id;
}

const write = (p: string, body: Buffer = PDF) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};

const get = (query: string) =>
  GET(new NextRequest(`http://localhost/api/profile/resume?${query}`));
const byId = (id: string) => get(`fileId=${encodeURIComponent(id)}`);

// Every refusal is the same empty 404: no reason, no file bytes.
async function expectHidden(res: Response | undefined) {
  expect(res!.status).toBe(404);
  const body = Buffer.from(await res!.arrayBuffer());
  expect(body.length).toBe(0);
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resume-sec-")));
  state.uploads = path.join(tmp, "uploads");
  resumes = path.join(state.uploads, "files", "resumes");
  fs.mkdirSync(resumes, { recursive: true });
  secret = write(path.join(tmp, "secret.pdf"), SECRET);
  userA = await seedUser("a@example.com");
  userB = await seedUser("b@example.com");
  statusId = (await prisma.jobStatus.create({ data: { label: "Draft", value: "draft" } })).id;
}, 120_000);

afterAll(async () => {
  await db.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue({ user: { id: userA } });
  vi.stubEnv("COCKPIT_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/profile/resume: normal download", () => {
  it("serves the user's own resume by File id, named after File.fileName", async () => {
    const p = write(path.join(resumes, `${crypto.randomUUID()}.pdf`));
    const id = await resumeFile(userA, p);
    const res = await byId(id);
    expect(res!.status).toBe(200);
    expect(Buffer.from(await res!.arrayBuffer())).toEqual(PDF);
    expect(res!.headers.get("Content-Type")).toBe("application/pdf");
    expect(res!.headers.get("Content-Disposition")).toBe(
      `attachment; filename="Jane_Doe_CV.pdf"; filename*=UTF-8''Jane_Doe_CV.pdf`,
    );
    expect(res!.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("serves a resume stored with a relative path (dev: UPLOADS_DIR is relative)", async () => {
    const p = write(path.join(resumes, `${crypto.randomUUID()}.docx`), Buffer.from("PK\u0003\u0004"));
    const id = await resumeFile(userA, path.relative(process.cwd(), p), "cv.docx");
    const res = await byId(id);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("serves the CV of the user's own cockpit package", async () => {
    const p = write(path.join(state.uploads, "files", "cockpit", userA, `${crypto.randomUUID()}.pdf`));
    const id = await cockpitFile(userA, p);
    const res = await byId(id);
    expect(res!.status).toBe(200);
    expect(Buffer.from(await res!.arrayBuffer())).toEqual(PDF);
  });
});

describe("GET /api/profile/resume: a path in the request is never read", () => {
  it("ignores the old ?filePath= with an absolute path outside the uploads dir", async () => {
    await expectHidden(await get(`filePath=${encodeURIComponent(secret)}`));
  });

  it("ignores ?filePath= with a traversal out of the resumes dir", async () => {
    const traversal = path.join(resumes, "..", "..", "..", "secret.pdf");
    await expectHidden(
      await get(`filePath=${encodeURIComponent(resumes + "/../../../secret.pdf")}`),
    );
    await expectHidden(await get(`filePath=${encodeURIComponent(traversal)}`));
  });

  it("ignores ?filePath= even when it names the user's own resume", async () => {
    const p = write(path.join(resumes, `${crypto.randomUUID()}.pdf`));
    await resumeFile(userA, p);
    await expectHidden(await get(`filePath=${encodeURIComponent(p)}`));
  });

  it("answers 404 to an absolute path given as the file id", async () => {
    await expectHidden(await byId(secret));
  });

  it("answers 404 to traversal given as the file id", async () => {
    await expectHidden(await byId("../../secret.pdf"));
    await expectHidden(await byId("..\\..\\secret.pdf"));
  });

  it("answers 404 to encoded and double-encoded traversal", async () => {
    await expectHidden(await get("fileId=%2e%2e%2f%2e%2e%2fsecret.pdf"));
    await expectHidden(await get("fileId=%252e%252e%252fsecret.pdf"));
    await expectHidden(await get(`fileId=${encodeURIComponent("%2e%2e%2f" + secret)}`));
    await expectHidden(await get("fileId=%00"));
  });

  it("answers 404 without a file id, and to an over-long one", async () => {
    await expectHidden(await get(""));
    await expectHidden(await byId("x".repeat(500)));
  });
});

describe("GET /api/profile/resume: ownership", () => {
  it("answers 404 to another user's resume file id", async () => {
    const p = write(path.join(resumes, `${crypto.randomUUID()}.pdf`));
    const id = await resumeFile(userB, p);
    await expectHidden(await byId(id));
    // The same id works for its owner: the 404 is ownership, not the file.
    authMock.mockResolvedValue({ user: { id: userB } });
    expect((await byId(id))!.status).toBe(200);
  });

  it("answers 404 to another user's cockpit CV file id", async () => {
    const p = write(path.join(state.uploads, "files", "cockpit", userB, `${crypto.randomUUID()}.pdf`));
    const id = await cockpitFile(userB, p);
    await expectHidden(await byId(id));
  });

  it("answers 404 to a File row that belongs to no resume and no package", async () => {
    const p = write(path.join(resumes, `${crypto.randomUUID()}.pdf`));
    const orphan = await prisma.file.create({
      data: { fileName: "x.pdf", filePath: p, fileType: "application/pdf" },
    });
    await expectHidden(await byId(orphan.id));
  });

  it("answers 404 to a cockpit CV while the cockpit is disabled", async () => {
    const p = write(path.join(state.uploads, "files", "cockpit", userA, `${crypto.randomUUID()}.pdf`));
    const id = await cockpitFile(userA, p);
    vi.stubEnv("COCKPIT_ENABLED", "false");
    await expectHidden(await byId(id));
  });

  it("answers 404 to a cockpit CV of this user stored in another user's cockpit dir", async () => {
    const p = write(path.join(state.uploads, "files", "cockpit", userB, `${crypto.randomUUID()}.pdf`));
    const id = await cockpitFile(userA, p);
    await expectHidden(await byId(id));
  });
});

describe("GET /api/profile/resume: stored path confinement", () => {
  it("answers 404 when the user's own row points outside the uploads dir (legacy row)", async () => {
    await expectHidden(await byId(await resumeFile(userA, secret)));
  });

  it("answers 404 when the stored path leaves the dir through '..'", async () => {
    const id = await resumeFile(userA, path.join(resumes, "..", "..", "..", "secret.pdf"));
    // path.join already folds the '..'; store the raw string too.
    const raw = await resumeFile(userA, `${resumes}/../../../secret.pdf`);
    await expectHidden(await byId(id));
    await expectHidden(await byId(raw));
  });

  it("answers 404 to a prefix trick (uploads-evil next to uploads)", async () => {
    const evil = write(path.join(`${state.uploads}-evil`, "files", "resumes", "x.pdf"));
    const evil2 = write(path.join(`${resumes}-evil`, "x.pdf"));
    await expectHidden(await byId(await resumeFile(userA, evil)));
    await expectHidden(await byId(await resumeFile(userA, evil2)));
  });

  it("answers 404 when a resume row points inside uploads but outside the resumes dir", async () => {
    const db = write(path.join(state.uploads, "dev.pdf"));
    const other = write(path.join(state.uploads, "files", "cockpit", userB, "cv.pdf"));
    await expectHidden(await byId(await resumeFile(userA, db)));
    await expectHidden(await byId(await resumeFile(userA, other)));
  });

  it("answers 404 when the stored file is a symlink pointing out of the uploads dir", async () => {
    const link = path.join(resumes, `${crypto.randomUUID()}.pdf`);
    fs.symlinkSync(secret, link);
    await expectHidden(await byId(await resumeFile(userA, link)));
  });

  it("answers 404 when a directory on the stored path is a symlink pointing out", async () => {
    const outDir = path.join(tmp, "outside-dir");
    write(path.join(outDir, "cv.pdf"), SECRET);
    const linkDir = path.join(resumes, `dir-${crypto.randomUUID()}`);
    fs.symlinkSync(outDir, linkDir);
    await expectHidden(await byId(await resumeFile(userA, path.join(linkDir, "cv.pdf"))));
  });

  it("answers 404 to a cockpit CV symlinked out of the user's cockpit dir", async () => {
    const link = path.join(state.uploads, "files", "cockpit", userA, `${crypto.randomUUID()}.pdf`);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(secret, link);
    await expectHidden(await byId(await cockpitFile(userA, link)));
  });

  it("answers 404 when the stored file is missing, a directory, or not a PDF/Word file", async () => {
    const gone = await resumeFile(userA, path.join(resumes, "gone.pdf"));
    const dir = await resumeFile(userA, resumes);
    const sub = path.join(resumes, `sub-${crypto.randomUUID()}.pdf`);
    fs.mkdirSync(sub);
    const dirLike = await resumeFile(userA, sub);
    const txt = await resumeFile(userA, write(path.join(resumes, "notes.txt"), Buffer.from("x")));
    for (const id of [gone, dir, dirLike, txt]) await expectHidden(await byId(id));
  });
});

describe("the stored path does not reach the client", () => {
  it("the resume detail include returns the File without filePath", async () => {
    const p = write(path.join(resumes, `${crypto.randomUUID()}.pdf`));
    const id = await resumeFile(userA, p);
    const resume = await prisma.resume.findFirst({
      where: { FileId: id },
      include: resumeDetailInclude,
    });
    expect(resume!.File).toMatchObject({ id, fileName: "Jane_Doe_CV.pdf" });
    expect(resume!.File).not.toHaveProperty("filePath");
    expect(JSON.stringify(resume)).not.toContain(p);
  });
});

describe("GET /api/profile/resume: authentication and method", () => {
  it("answers 401 without a session, before any lookup", async () => {
    authMock.mockResolvedValue(null);
    const res = await get(`filePath=${encodeURIComponent(secret)}`);
    expect(res!.status).toBe(401);
  });

  it("answers 401 to a session without a user id", async () => {
    authMock.mockResolvedValue({ user: {} });
    const p = write(path.join(resumes, `${crypto.randomUUID()}.pdf`));
    const id = await resumeFile(userA, p);
    expect((await byId(id))!.status).toBe(401);
  });

  it("is behind the middleware: an anonymous request is not authorized (redirect to /signin)", () => {
    const pattern = middlewareConfig.matcher.find((m) => m.startsWith("/api/"))!;
    // Next matchers are path-to-regexp; this one is a plain regex group.
    expect(new RegExp(`^${pattern}$`).test("/api/profile/resume")).toBe(true);
    const authorized = authConfig.callbacks.authorized as unknown as (a: {
      auth: null;
      request: { nextUrl: URL };
    }) => boolean;
    expect(
      authorized({ auth: null, request: { nextUrl: new URL("http://localhost/api/profile/resume?fileId=x") } }),
    ).toBe(false);
  });

  it("exports only GET and POST, so Next answers 405 to any other method", () => {
    for (const m of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect((route as Record<string, unknown>)[m]).toBeUndefined();
    }
    expect(typeof route.GET).toBe("function");
    expect(typeof route.POST).toBe("function");
  });
});
