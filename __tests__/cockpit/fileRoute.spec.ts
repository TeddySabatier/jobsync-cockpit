// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";

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
vi.mock("@/lib/db", () => ({
  default: { applicationPackage: { findFirst: vi.fn() } },
}));

import { NextRequest } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/db";
import { GET } from "@/app/api/cockpit/files/[packageId]/route";

const find = prisma.applicationPackage.findFirst as ReturnType<typeof vi.fn>;
const authMock = auth as unknown as ReturnType<typeof vi.fn>;

let root: string;
const call = (id = "p1") =>
  GET(new NextRequest(`http://localhost/api/cockpit/files/${id}`), {
    params: Promise.resolve({ packageId: id }),
  });

const store = (userId: string, name: string, body = "%PDF-1.4 body") => {
  const p = path.join(root, "files", "cockpit", userId, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("COCKPIT_ENABLED", "true");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-route-"));
  state.uploads = root;
  authMock.mockResolvedValue({ user: { id: "u1" } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /api/cockpit/files/[packageId] (AC-16)", () => {
  it("flag off → 404 before auth is consulted", async () => {
    vi.stubEnv("COCKPIT_ENABLED", "false");
    const res = await call();
    expect(res.status).toBe(404);
    expect(authMock).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  it("no session → 401 JSON from the fixed map, no DB access", async () => {
    authMock.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      success: false,
      code: "UNAUTHENTICATED",
      message: "Not authenticated",
    });
    expect(find).not.toHaveBeenCalled();
  });

  it("session without user id → 401", async () => {
    authMock.mockResolvedValue({ user: {} });
    expect((await call()).status).toBe(401);
  });

  it("missing or other user's package → 404 empty body; query scoped by userId", async () => {
    find.mockResolvedValue(null);
    const res = await call("p9");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(find.mock.calls[0][0].where).toEqual({ id: "p9", userId: "u1" });
  });

  it("package without a CV file → 404", async () => {
    find.mockResolvedValue({ cvFile: null });
    expect((await call()).status).toBe(404);
  });

  it("file of another user's dir (u10 vs u1) → 404", async () => {
    const other = store("u10", "x.pdf");
    find.mockResolvedValue({ cvFile: { filePath: other } });
    expect((await call()).status).toBe(404);
  });

  it("traversal out of the cockpit dir → 404", async () => {
    store("u1", "ok.pdf");
    const secret = path.join(root, "secret.pdf");
    fs.writeFileSync(secret, "%PDF-");
    find.mockResolvedValue({
      cvFile: {
        filePath: path.join(root, "files", "cockpit", "u1", "..", "..", "..", "secret.pdf"),
      },
    });
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("file missing on disk → 404", async () => {
    find.mockResolvedValue({
      cvFile: { filePath: path.join(root, "files", "cockpit", "u1", "gone.pdf") },
    });
    expect((await call()).status).toBe(404);
  });

  it("owned file → 200 PDF with the generated name and one CSP value", async () => {
    const p = store("u1", "0a1b2c3d-generated.pdf", "%PDF-1.4 hello");
    find.mockResolvedValue({
      cvFile: { filePath: p, fileName: 'stored "name".pdf' },
    });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      'inline; filename="0a1b2c3d-generated.pdf"',
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "sandbox; frame-ancestors 'self'",
    );
    expect(res.headers.get("Content-Length")).toBe("14");
    expect(await res.text()).toBe("%PDF-1.4 hello");
  });
});
