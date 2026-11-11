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

import { attachFile, cleanupOrphanUploads } from "@/lib/cockpit/attachments";
import { cockpitUserDir } from "@/lib/cockpit/files";
import { log } from "@/lib/telemetry";
import { pdfBase64 } from "./helpers/mcpClient";

const prisma = db.prisma;
const DAY = 86_400_000;

let root: string;
let userA: string;
let userB: string;
let draftId: string;
let seq = 0;

beforeAll(async () => {
  userA = (await prisma.user.create({ data: { name: "A", email: "a@example.com", password: "x" } })).id;
  userB = (await prisma.user.create({ data: { name: "B", email: "b@example.com", password: "x" } })).id;
  draftId = (await prisma.jobStatus.create({ data: { label: "Draft", value: "draft" } })).id;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-att-"));
  uploads.dir = root;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// A stored upload: bytes on disk (aged `days`) plus, unless noRow, a File row
// whose filePath is `pathForm(real path)`.
async function store(
  userId: string,
  days: number,
  opts: { noRow?: boolean; pathForm?: (p: string) => string } = {},
) {
  const dir = cockpitUserDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, `${++seq}-${Math.random().toString(16).slice(2)}.pdf`);
  fs.writeFileSync(full, "%PDF-1.4");
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(full, t, t);
  const row = opts.noRow
    ? null
    : await prisma.file.create({
        data: {
          fileName: "f.pdf",
          filePath: (opts.pathForm ?? ((p) => p))(full),
          fileType: "application/pdf",
        },
      });
  return { full, id: row?.id };
}

const rowExists = async (id?: string) =>
  !!id && !!(await prisma.file.findUnique({ where: { id } }));

async function makePackage(userId: string, cvFileId: string) {
  const title = await prisma.jobTitle.create({
    data: { label: "E", value: `e-${++seq}`, createdBy: userId },
  });
  const company = await prisma.company.create({
    data: { label: "C", value: `c-${seq}`, createdBy: userId },
  });
  const job = await prisma.job.create({
    data: {
      userId,
      description: "d",
      jobType: "FT",
      createdAt: new Date(),
      statusId: draftId,
      jobTitleId: title.id,
      companyId: company.id,
    },
  });
  return prisma.applicationPackage.create({
    data: {
      userId,
      jobId: job.id,
      version: 1,
      emailTo: "hr@example.com",
      emailSubject: "s",
      emailBody: "b",
      fitGrade: "A",
      cvFileId,
    },
  });
}

describe("cleanupOrphanUploads", () => {
  it("removes an old unreferenced upload with its row, keeps a recent one", async () => {
    const old = await store(userA, 10);
    const fresh = await store(userA, 2);
    expect(await cleanupOrphanUploads(userA)).toBe(1);
    expect(fs.existsSync(old.full)).toBe(false);
    expect(await rowExists(old.id)).toBe(false);
    expect(fs.existsSync(fresh.full)).toBe(true);
    expect(await rowExists(fresh.id)).toBe(true);
  });

  it("never touches another user's directory", async () => {
    const mine = await store(userA, 10);
    const theirs = await store(userB, 10);
    await cleanupOrphanUploads(userA);
    expect(fs.existsSync(mine.full)).toBe(false);
    expect(fs.existsSync(theirs.full)).toBe(true);
    expect(await rowExists(theirs.id)).toBe(true);
  });

  it("keeps a file that only a Resume references", async () => {
    const f = await store(userA, 10);
    await prisma.resume.create({
      data: { profileId: (await prisma.profile.create({ data: { userId: userA } })).id, title: "R", FileId: f.id },
    });
    expect(await cleanupOrphanUploads(userA)).toBe(0);
    expect(fs.existsSync(f.full)).toBe(true);
    expect(await rowExists(f.id)).toBe(true);
  });

  it("keeps a file that a package references", async () => {
    const f = await store(userA, 10);
    await makePackage(userA, f.id!);
    expect(await cleanupOrphanUploads(userA)).toBe(0);
    expect(fs.existsSync(f.full)).toBe(true);
    expect(await rowExists(f.id)).toBe(true);
  });

  it("removes a stray file that has no row", async () => {
    const stray = await store(userA, 10, { noRow: true });
    expect(await cleanupOrphanUploads(userA)).toBe(1);
    expect(fs.existsSync(stray.full)).toBe(false);
  });

  it("keeps a referenced file whose stored path is in another string form (relative vs absolute)", async () => {
    const rel = await store(userA, 10, { pathForm: (p) => path.relative(process.cwd(), p) });
    const dotted = await store(userA, 10, {
      pathForm: (p) => path.join(path.dirname(p), ".", path.basename(p)),
    });
    await makePackage(userA, rel.id!);
    await makePackage(userA, dotted.id!);
    expect(await cleanupOrphanUploads(userA)).toBe(0);
    for (const f of [rel, dotted]) {
      expect(fs.existsSync(f.full)).toBe(true);
      expect(await rowExists(f.id)).toBe(true);
    }
  });

  it("removes an unreferenced file whose row has a relative path, with the row", async () => {
    const f = await store(userA, 10, { pathForm: (p) => path.relative(process.cwd(), p) });
    expect(await cleanupOrphanUploads(userA)).toBe(1);
    expect(fs.existsSync(f.full)).toBe(false);
    expect(await rowExists(f.id)).toBe(false);
  });

  it("a package that claims the row after the check keeps its file (race-safe delete)", async () => {
    const f = await store(userA, 10);
    // The claim lands between the row lookup and the delete.
    const realFindMany = prisma.file.findMany.bind(prisma.file);
    vi.spyOn(prisma.file, "findMany").mockImplementation(((args: never) =>
      realFindMany(args).then(async (r) => {
        await makePackage(userA, f.id!);
        return r;
      })) as never);
    expect(await cleanupOrphanUploads(userA)).toBe(0);
    expect(fs.existsSync(f.full)).toBe(true);
    expect(await rowExists(f.id)).toBe(true);
    const pkg = await prisma.applicationPackage.findFirst({ where: { cvFileId: f.id } });
    expect(pkg).not.toBeNull();
  });

  it("removes a symlink without touching its target", async () => {
    const outside = path.join(root, "outside.pdf");
    fs.writeFileSync(outside, "%PDF-secret");
    const dir = cockpitUserDir(userA);
    fs.mkdirSync(dir, { recursive: true });
    const link = path.join(dir, "link.pdf");
    fs.symlinkSync(outside, link);
    const t = new Date(Date.now() - 10 * DAY);
    fs.lutimesSync(link, t, t);
    expect(await cleanupOrphanUploads(userA)).toBe(1);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("%PDF-secret");
  });

  it("deletes the row before the bytes: a failing rm leaves no row pointing at a kept file", async () => {
    const f = await store(userA, 10);
    // A directory entry the rm cannot remove would be exotic; instead check order.
    const order: string[] = [];
    const del = prisma.file.deleteMany.bind(prisma.file);
    vi.spyOn(prisma.file, "deleteMany").mockImplementation(((a: never) => {
      order.push(fs.existsSync(f.full) ? "row-while-file-exists" : "row-after-file");
      return del(a);
    }) as never);
    await cleanupOrphanUploads(userA);
    expect(order).toEqual(["row-while-file-exists"]);
    expect(fs.existsSync(f.full)).toBe(false);
  });

  describe("COCKPIT_ORPHAN_DAYS", () => {
    it.each([
      ["unset", undefined, 5, false],
      ["0", "0", 5, false],
      ["abc", "abc", 5, false],
      ["0.5", "0.5", 5, false],
      ["1", "1", 2, true],
      ["1.5 days", "1.5", 2, true],
      ["1.5 days keeps a 1-day-old file", "1.5", 1, false],
      ["30 keeps a 10-day-old file", "30", 10, false],
    ])("%s", async (_label, value, ageDays, removed) => {
      if (value !== undefined) vi.stubEnv("COCKPIT_ORPHAN_DAYS", value);
      const f = await store(userA, ageDays);
      expect(await cleanupOrphanUploads(userA)).toBe(removed ? 1 : 0);
      expect(fs.existsSync(f.full)).toBe(!removed);
    });

    it("an invalid value is reported once per process, not silent", async () => {
      vi.resetModules(); // fresh module: the once-flag starts unset
      const fresh = await import("@/lib/cockpit/attachments");
      const { log: freshLog } = await import("@/lib/telemetry");
      const warn = vi.spyOn(freshLog, "warn").mockImplementation(() => {});
      vi.stubEnv("COCKPIT_ORPHAN_DAYS", "0.5");
      await store(userA, 1);
      await fresh.cleanupOrphanUploads(userA);
      await fresh.cleanupOrphanUploads(userA);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "cockpit: COCKPIT_ORPHAN_DAYS ignored, using the default",
        { code: "ORPHAN_DAYS_INVALID" },
      );
    });
  });
});

describe("attachFile", () => {
  it("a failing cleanup does not block the upload", async () => {
    vi.spyOn(prisma.file, "findMany").mockRejectedValue(new Error("db down"));
    await store(userA, 10, { noRow: true });
    const res = await attachFile(userA, { fileName: "cv.pdf", contentBase64: pdfBase64("x") });
    expect(res.fileName).toBe("cv.pdf");
    const row = await prisma.file.findUniqueOrThrow({ where: { id: res.fileId } });
    expect(fs.existsSync(row.filePath)).toBe(true);
  });
});

// Edge cases found while mutation-checking the cleanup (issue #55).
describe("cleanupOrphanUploads: edge cases", () => {
  it("age boundary: a file exactly COCKPIT_ORPHAN_DAYS old is kept, one millisecond older goes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = new Date("2030-01-15T12:00:00.000Z");
      vi.setSystemTime(now);
      vi.stubEnv("COCKPIT_ORPHAN_DAYS", "7");
      const dir = cockpitUserDir(userA);
      fs.mkdirSync(dir, { recursive: true });
      const mk = (name: string, mtimeMs: number) => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, "%PDF-1.4");
        fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
        return p;
      };
      const edge = mk("edge.pdf", now.getTime() - 7 * DAY);
      const older = mk("older.pdf", now.getTime() - 7 * DAY - 1000);
      expect(await cleanupOrphanUploads(userA)).toBe(1);
      expect(fs.existsSync(edge)).toBe(true);
      expect(fs.existsSync(older)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fresh upload that has no row yet (concurrent upload in flight) is kept", async () => {
    const inflight = await store(userA, 0, { noRow: true });
    expect(await cleanupOrphanUploads(userA)).toBe(0);
    expect(fs.existsSync(inflight.full)).toBe(true);
  });

  it("a row whose bytes are gone is left alone (cleanup is driven by the directory)", async () => {
    const gone = await store(userA, 10);
    fs.rmSync(gone.full);
    expect(await cleanupOrphanUploads(userA)).toBe(0);
    expect(await rowExists(gone.id)).toBe(true);
  });

  it("a subdirectory is ignored, not removed", async () => {
    const dir = cockpitUserDir(userA);
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const t = new Date(Date.now() - 10 * DAY);
    fs.utimesSync(sub, t, t);
    expect(await cleanupOrphanUploads(userA)).toBe(0);
    expect(fs.existsSync(sub)).toBe(true);
  });

  it("keeps the file when a row stores a foreign Windows-style path (never cleaned, safe direction)", async () => {
    const f = await store(userA, 10, {
      pathForm: (p) => ["C:", "uploads", "cockpit", userA, path.basename(p)].join(String.fromCharCode(92)),
    });
    await makePackage(userA, f.id!);
    expect(await cleanupOrphanUploads(userA)).toBe(0);
    expect(fs.existsSync(f.full)).toBe(true);
    expect(await rowExists(f.id)).toBe(true);
  });

  it("a row whose path differs from the file only in case still claims it", async () => {
    const f = await store(userA, 10, {
      pathForm: (p) => path.join(path.dirname(p), path.basename(p).toUpperCase()),
    });
    await makePackage(userA, f.id!);
    expect(await cleanupOrphanUploads(userA)).toBe(0);
    expect(fs.existsSync(f.full)).toBe(true);
    expect(await rowExists(f.id)).toBe(true);
  });

  it("attempts no delete for rows a package already references", async () => {
    const used = await store(userA, 10);
    await makePackage(userA, used.id!);
    const free = await store(userA, 10);
    const spy = vi.spyOn(prisma.file, "deleteMany");
    expect(await cleanupOrphanUploads(userA)).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]?.where).toMatchObject({ id: free.id });
    expect(fs.existsSync(used.full)).toBe(true);
  });

  it("does not delete the row of a different file whose name merely ends with the same text", async () => {
    const old = await store(userA, 10);
    // Another upload (fresh, unreferenced) whose stored name has the old name as a suffix.
    const other = await store(userA, 0, {
      pathForm: (p) => path.join(path.dirname(p), `keep-${path.basename(old.full)}`),
    });
    await cleanupOrphanUploads(userA);
    expect(fs.existsSync(old.full)).toBe(false);
    expect(await rowExists(old.id)).toBe(false);
    expect(await rowExists(other.id)).toBe(true);
  });

  it("never deletes another user's row, even when its file name is identical", async () => {
    const mine = await store(userA, 10);
    const theirs = await store(userB, 10, {
      pathForm: (p) => path.join(path.dirname(p), path.basename(mine.full)),
    });
    await cleanupOrphanUploads(userA);
    expect(fs.existsSync(theirs.full)).toBe(true);
    expect(await rowExists(theirs.id)).toBe(true);
  });
});
