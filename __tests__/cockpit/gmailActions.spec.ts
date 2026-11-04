// @vitest-environment node

vi.mock("@/lib/db", () => ({
  default: { gmailAccount: { findUnique: vi.fn(), deleteMany: vi.fn() } },
}));
vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "u1", name: "", email: "" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { disconnectGmail, getGmailSettings } from "@/actions/cockpitGmail.actions";

const findAccount = prisma.gmailAccount.findUnique as ReturnType<typeof vi.fn>;
const deleteMany = prisma.gmailAccount.deleteMany as ReturnType<typeof vi.fn>;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("COCKPIT_ENABLED", "true");
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id.example.test");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret-placeholder");
  vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", "you@example.com");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
  findAccount.mockReset();
  deleteMany.mockReset().mockResolvedValue({ count: 1 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("disconnectGmail", () => {
  it("revokes the stored token, then deletes the row for this user only", async () => {
    const stored = encrypt("refresh-1");
    findAccount.mockResolvedValue({ encryptedRefreshToken: stored.encrypted, iv: stored.iv });
    expect(await disconnectGmail()).toEqual({ success: true, data: { disconnected: true } });

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(fetchMock.mock.calls[0][1].body as string).get("token")).toBe(
      "refresh-1",
    );
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("deletes the row even when the revoke fails or the key is lost", async () => {
    const stored = encrypt("refresh-1");
    findAccount.mockResolvedValue({ encryptedRefreshToken: stored.encrypted, iv: stored.iv });
    fetchMock.mockResolvedValue(new Response("{}", { status: 400 }));
    expect((await disconnectGmail()).success).toBe(true);

    vi.stubEnv("ENCRYPTION_KEY", "another-key-placeholder");
    fetchMock.mockClear();
    expect((await disconnectGmail()).success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deleteMany).toHaveBeenCalledTimes(2);
  });

  it("nothing connected: no Google call, still succeeds", async () => {
    findAccount.mockResolvedValue(null);
    expect((await disconnectGmail()).success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getGmailSettings (AC-43)", () => {
  it("reads the account with an explicit select of email and scopes", async () => {
    findAccount.mockResolvedValue({ email: "you@example.com", scopes: "s" });
    const r = await getGmailSettings();
    expect(findAccount).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { email: true, scopes: true },
    });
    expect(r).toEqual({
      success: true,
      data: { missingEnv: [], account: { email: "you@example.com", scopes: "s" } },
    });
  });

  it("lists missing env var names, never values", async () => {
    vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", "");
    findAccount.mockResolvedValue(null);
    const r = await getGmailSettings();
    expect(r).toMatchObject({
      success: true,
      data: { missingEnv: ["COCKPIT_GMAIL_ALLOWED_ADDRESS"] },
    });
  });
});
