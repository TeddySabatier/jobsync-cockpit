// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import {
  contentDisposition,
  nameFromContentDisposition,
  safeDownloadName,
} from "@/lib/downloadName";

// Issue #60 review (S2): a restored backup names resume files <id>.<ext> on
// disk, so the download must use the display name (File.fileName). Since
// issue #78 the route takes a File id; the security cases live in
// resumeDownloadSecurity.spec.ts (real SQLite).

const state = vi.hoisted(() => ({ uploads: "" }));
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
vi.mock("@/actions/profile.actions", () => ({
  createResumeProfile: vi.fn(),
  deleteFile: vi.fn(),
  editResume: vi.fn(),
  uploadFile: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  default: { file: { findFirst: vi.fn() } },
}));

import { auth } from "@/auth";
import db from "@/lib/db";
import { GET } from "@/app/api/profile/resume/route";

const findFirst = (db as unknown as { file: { findFirst: ReturnType<typeof vi.fn> } }).file
  .findFirst;

let dir: string;
let restored: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-dl-"));
  state.uploads = dir;
  restored = path.join(dir, "files", "resumes", "0f8b5c1e-3a1d-4c55-9a52-5d0c6b1e2f77.pdf");
  fs.mkdirSync(path.dirname(restored), { recursive: true });
  fs.writeFileSync(restored, "%PDF-1.4\n");
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: "user-1" } });
  findFirst.mockReset();
});

const row = (fileName: string) => ({
  fileName,
  filePath: restored,
  Resume: { profile: { userId: "user-1" } },
});
const get = () =>
  GET(new NextRequest("http://localhost/api/profile/resume?fileId=f1"));

describe("GET /api/profile/resume download name", () => {
  it("names a restored resume by its display name, looked up by id for this user", async () => {
    findFirst.mockResolvedValue(row("Jane_Doe_CV.pdf"));
    const res = await get();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Disposition")).toBe(
      `attachment; filename="Jane_Doe_CV.pdf"; filename*=UTF-8''Jane_Doe_CV.pdf`,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "f1",
          OR: [
            { Resume: { profile: { userId: "user-1" } } },
            { applicationPackages: { some: { userId: "user-1" } } },
          ],
        },
      }),
    );
  });

  it("falls back to the name on disk when the display name is empty", async () => {
    findFirst.mockResolvedValue(row(""));
    const res = await get();
    expect(res!.headers.get("Content-Disposition")).toContain(
      `filename="${path.basename(restored)}"`,
    );
  });

  it("sanitizes a hostile or non-ASCII display name for the header", async () => {
    findFirst.mockResolvedValue(row('a"b\r\nc/../Łukasz CV.pdf'));
    const res = await get();
    const header = res!.headers.get("Content-Disposition")!;
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain(`filename="a_b__c_..__ukasz CV.pdf"`);
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent("a_b__c_.._Łukasz CV.pdf")}`);
  });
});

describe("safeDownloadName", () => {
  it("prefers the display name and replaces separators, quotes and control characters", () => {
    expect(safeDownloadName("My CV.pdf", "x.pdf")).toBe("My CV.pdf");
    expect(safeDownloadName('..\\a/b"c\n.pdf', "x.pdf")).toBe(".._a_b_c_.pdf");
  });

  it("falls back when the display name is empty or a dot name", () => {
    expect(safeDownloadName(undefined, "x.pdf")).toBe("x.pdf");
    expect(safeDownloadName("  ", "x.pdf")).toBe("x.pdf");
    expect(safeDownloadName("..", "x.pdf")).toBe("x.pdf");
  });

  it("encodes characters RFC 5987 does not allow raw", () => {
    expect(contentDisposition("CV (final)*.pdf")).toBe(
      `attachment; filename="CV (final)*.pdf"; filename*=UTF-8''CV%20%28final%29%2A.pdf`,
    );
  });
});

describe("nameFromContentDisposition", () => {
  it("reads back what contentDisposition writes, UTF-8 name first", () => {
    expect(nameFromContentDisposition(contentDisposition("Łukasz CV (1).pdf"))).toBe(
      "Łukasz CV (1).pdf",
    );
    expect(nameFromContentDisposition(`attachment; filename="abc.pdf"`)).toBe("abc.pdf");
  });

  it("falls back to the plain name on a malformed encoding, and is empty without a header", () => {
    expect(
      nameFromContentDisposition(`attachment; filename="a.pdf"; filename*=UTF-8''%E0%A4%A`),
    ).toBe("a.pdf");
    expect(nameFromContentDisposition(null)).toBe("");
    expect(nameFromContentDisposition("inline")).toBe("");
  });
});
