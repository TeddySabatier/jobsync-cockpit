// @vitest-environment node
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({
  default: { applicationPackage: { findFirst: vi.fn() } },
}));

import { NextRequest } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/db";
import { GET } from "@/app/api/cockpit/letter/[packageId]/route";
import { letterAttachmentName } from "@/lib/cockpit/attachments";

const find = prisma.applicationPackage.findFirst as ReturnType<typeof vi.fn>;
const authMock = auth as unknown as ReturnType<typeof vi.fn>;
const call = (id = "p1") =>
  GET(new NextRequest(`http://localhost/api/cockpit/letter/${id}`), {
    params: Promise.resolve({ packageId: id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("COCKPIT_ENABLED", "true");
  authMock.mockResolvedValue({ user: { id: "u1" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/cockpit/letter/[packageId] (D-015)", () => {
  it("flag off: 404 before auth is consulted", async () => {
    vi.stubEnv("COCKPIT_ENABLED", "false");
    expect((await call()).status).toBe(404);
    expect(authMock).not.toHaveBeenCalled();
  });

  it("no session: 401 and no database access", async () => {
    authMock.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(find).not.toHaveBeenCalled();
  });

  it("asks for the package of the signed-in user only (ownership)", async () => {
    find.mockResolvedValue(null);
    expect((await call("p9")).status).toBe(404);
    expect(find.mock.calls[0][0].where).toEqual({ id: "p9", userId: "u1" });
  });

  it("no letter text: 404", async () => {
    for (const letterMd of [null, "", "  \n"]) {
      find.mockResolvedValue({ letterMd, cvJson: null });
      expect((await call()).status).toBe(404);
    }
  });

  it("names the download like the attachment the recipient gets (same helper as Send and the dialog)", async () => {
    find.mockResolvedValue({ letterMd: "Hi", cvJson: null, cvFile: { fileName: "Jane(CV).pdf" } });
    const res = await call();
    expect(res.headers.get("content-disposition")).toBe('inline; filename="Jane_Cover_Letter_.pdf"');
    expect(letterAttachmentName("Jane(CV).pdf")).toBe("Jane_Cover_Letter_.pdf");
    expect(letterAttachmentName("CV–Acme.pdf")).toBe("Cover_Letter_Acme.pdf");
    expect(letterAttachmentName(null)).toBe("attachment_Cover_Letter.pdf");
  });

  it("serves a PDF with the sandbox and no-store headers", async () => {
    find.mockResolvedValue({ letterMd: "Hello team", cvJson: null });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; frame-ancestors 'self'");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(Number(res.headers.get("content-length"))).toBe(body.length);
  });
});
