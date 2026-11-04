// @vitest-environment node

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({
  default: { gmailAccount: { findUnique: vi.fn(), upsert: vi.fn() } },
}));

import { NextRequest } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/db";
import { CockpitError } from "@/lib/cockpit/errors";
import { encrypt } from "@/lib/encryption";
import {
  createHttpGmailClient,
  exchangeAuthCode,
  getAccessToken,
  getAccessTokenFromStored,
  revokeToken,
  sendRaw,
} from "@/lib/cockpit/gmail/client";
import { COOKIE_NAME, getGoogleConfig } from "@/lib/cockpit/gmail/oauth";
import { GET as callback } from "@/app/api/cockpit/gmail/callback/route";

// AC-27, AC-36 (OAuth/token part). fetch is stubbed; nothing reaches Google.
const SECRET = "SECRET-TOKEN-VALUE";
const fetchMock = vi.fn();
const spies = {
  log: vi.spyOn(console, "log"),
  info: vi.spyOn(console, "info"),
  warn: vi.spyOn(console, "warn"),
  error: vi.spyOn(console, "error"),
};
const logged = () =>
  JSON.stringify(Object.values(spies).flatMap((s) => s.mock.calls));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

const caught = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as CockpitError;
  }
  throw new Error("expected a rejection");
};

beforeEach(() => {
  vi.stubEnv("COCKPIT_ENABLED", "true");
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id.example.test");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret-placeholder");
  vi.stubEnv("GOOGLE_REDIRECT_URI", "http://localhost:3737/api/cockpit/gmail/callback");
  vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", "you@example.com");
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  Object.values(spies).forEach((s) => s.mockImplementation(() => {}));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("createHttpGmailClient (AC-27)", () => {
  it("throws under Vitest", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(() => createHttpGmailClient()).toThrow(/Vitest/);
  });
});

describe("typed Google errors", () => {
  const cfg = () => getGoogleConfig()!;

  it("token endpoint failure → GMAIL_TOKEN, definitive, status only", async () => {
    fetchMock.mockResolvedValue(json(500, { error: "x", detail: SECRET }));
    const e = await caught(getAccessToken(SECRET));
    expect(e).toBeInstanceOf(CockpitError);
    expect(e).toMatchObject({ code: "GMAIL_TOKEN", status: 500, definitive: true });
    expect(e.message).not.toContain(SECRET);
  });

  it("invalid_grant → GMAIL_RECONNECT_REQUIRED", async () => {
    fetchMock.mockResolvedValue(json(400, { error: "invalid_grant" }));
    expect(await caught(getAccessToken("r"))).toMatchObject({
      code: "GMAIL_RECONNECT_REQUIRED",
      status: 400,
      definitive: true,
    });
  });

  it("timeout → GMAIL_TIMEOUT (definitive for token, ambiguous for send)", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    fetchMock.mockRejectedValue(timeout);
    expect(await caught(getAccessToken("r"))).toMatchObject({ code: "GMAIL_TIMEOUT", definitive: true });
    expect(await caught(sendRaw("a", "raw"))).toMatchObject({ code: "GMAIL_TIMEOUT", definitive: false });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [400, true],
    [401, true],
    [403, true],
    [429, false],
    [500, false],
    [503, false],
  ])("send HTTP %i → GMAIL_SEND definitive=%s", async (status, definitive) => {
    fetchMock.mockResolvedValue(json(status, { error: { message: SECRET } }));
    const e = await caught(sendRaw("a", "raw"));
    expect(e).toMatchObject({ code: "GMAIL_SEND", status, definitive });
  });

  it("send network error → GMAIL_SEND, ambiguous; unreadable 2xx → ambiguous", async () => {
    fetchMock.mockRejectedValueOnce(new Error(`boom ${SECRET}`));
    const net = await caught(sendRaw("a", "raw"));
    expect(net).toMatchObject({ code: "GMAIL_SEND", definitive: false });
    expect(net.message).not.toContain(SECRET);

    fetchMock.mockResolvedValueOnce(json(200, {}));
    expect(await caught(sendRaw("a", "raw"))).toMatchObject({ code: "GMAIL_SEND", definitive: false });
  });

  it("returns ids on a good send, and a refreshed access token", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: "m1", threadId: "t1" }));
    expect(await sendRaw("a", "raw")).toEqual({ id: "m1", threadId: "t1" });
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "acc" }));
    expect(await getAccessToken("r")).toBe("acc");
    const call = fetchMock.mock.calls[1];
    expect(new URLSearchParams(call[1].body as string).get("grant_type")).toBe("refresh_token");
  });

  it("revoke failure is typed; exchange returns the three fields", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: "invalid_token" }));
    expect(await caught(revokeToken("r"))).toMatchObject({ code: "GMAIL_TOKEN", status: 400 });
    fetchMock.mockResolvedValueOnce(
      json(200, { refresh_token: "r", id_token: "i", scope: "s", access_token: "a" }),
    );
    expect(await exchangeAuthCode(cfg(), "c", "v")).toEqual({
      refreshToken: "r",
      idToken: "i",
      scope: "s",
    });
  });
});

describe("stored token decrypt failure", () => {
  it("a changed or missing ENCRYPTION_KEY → GMAIL_RECONNECT_REQUIRED, no Google call", async () => {
    const stored = encrypt("refresh-1");
    vi.stubEnv("ENCRYPTION_KEY", "a-different-key-placeholder");
    expect(await caught(getAccessTokenFromStored(stored.encrypted, stored.iv))).toMatchObject({
      code: "GMAIL_RECONNECT_REQUIRED",
      definitive: true,
    });
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(await caught(getAccessTokenFromStored(stored.encrypted, stored.iv))).toMatchObject({
      code: "GMAIL_RECONNECT_REQUIRED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("decrypts and refreshes with the right key", async () => {
    const stored = encrypt("refresh-1");
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "acc" }));
    expect(await getAccessTokenFromStored(stored.encrypted, stored.iv)).toBe("acc");
    expect(new URLSearchParams(fetchMock.mock.calls[0][1].body as string).get("refresh_token")).toBe(
      "refresh-1",
    );
  });
});

describe("no secrets in logs (AC-36)", () => {
  const cookie = Buffer.from(
    JSON.stringify({ state: "S1", verifier: `${SECRET}-VERIFIER`, userId: "u1", nonce: "N1" }),
  ).toString("base64url");
  const run = async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: "u1" } });
    (prisma.gmailAccount.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await callback(
      new NextRequest(
        `http://internal/api/cockpit/gmail/callback?state=S1&code=${SECRET}-CODE`,
        { headers: { cookie: `${COOKIE_NAME}=${cookie}` } },
      ),
    );
    return res.headers.get("location") ?? "";
  };
  const exposures = async (response: () => Response | Promise<Response>) => {
    fetchMock.mockImplementation(async () => response());
    const loc = await run();
    return logged() + loc;
  };

  it("success path with refresh_token=SECRET", async () => {
    const out = await exposures(() =>
      json(200, { refresh_token: SECRET, access_token: SECRET, scope: "openid", id_token: `a.${SECRET}.c` }),
    );
    expect(out).not.toContain(SECRET);
  });

  it("failing token endpoint that echoes the secret", async () => {
    const out = await exposures(() => json(400, { error: SECRET, error_description: SECRET }));
    expect(out).not.toContain(SECRET);
    expect(out).toContain("token_exchange_failed"); // the code itself is logged
  });

  it("network failure whose message carries the secret", async () => {
    const out = await exposures(() => {
      throw new Error(`connect ECONNREFUSED ${SECRET}`);
    });
    expect(out).not.toContain(SECRET);
  });

  it("Gmail error body echoing parts of raw is not logged or thrown", async () => {
    fetchMock.mockResolvedValue(json(400, { error: { message: `bad raw ${SECRET}` } }));
    const e = await caught(sendRaw(SECRET, SECRET));
    expect(logged() + e.message + JSON.stringify(e)).not.toContain(SECRET);
    expect(logged()).toContain("GMAIL_SEND");
  });
});
