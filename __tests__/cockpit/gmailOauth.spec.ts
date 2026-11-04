// @vitest-environment node
import { createHash } from "crypto";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({
  default: {
    gmailAccount: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import { NextRequest } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/db";
import { decrypt, encrypt } from "@/lib/encryption";
import { GET as connect } from "@/app/api/cockpit/gmail/connect/route";
import { GET as callback } from "@/app/api/cockpit/gmail/callback/route";
import { COOKIE_NAME, decodeCookie } from "@/lib/cockpit/gmail/oauth";

// AC-22, AC-23. Synthetic ids only; fetch is stubbed, nothing reaches Google.
const CLIENT_ID = "client-id.example.test";
const ALLOWED = "you@example.com";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const REDIRECT = "https://cockpit.example.test/api/cockpit/gmail/callback";

const authMock = auth as unknown as ReturnType<typeof vi.fn>;
const findAccount = prisma.gmailAccount.findUnique as ReturnType<typeof vi.fn>;
const upsert = prisma.gmailAccount.upsert as ReturnType<typeof vi.fn>;
const fetchMock = vi.fn();

const idToken = (over: Record<string, unknown> = {}, nonce = "N1") => {
  const claims = {
    aud: CLIENT_ID,
    iss: "https://accounts.google.com",
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce,
    email: ALLOWED,
    email_verified: true,
    ...over,
  };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
};

const tokenResponse = (over: Record<string, unknown> = {}, claims = {}) =>
  new Response(
    JSON.stringify({
      access_token: "access-1",
      refresh_token: "refresh-new",
      scope: `${SEND} openid email`,
      id_token: idToken(claims),
      ...over,
    }),
    { status: 200 },
  );

const COOKIE = {
  state: "STATE1",
  verifier: "VERIFIER1",
  userId: "u1",
  nonce: "N1",
};
const cookieValue = (p: object = COOKIE) =>
  Buffer.from(JSON.stringify(p)).toString("base64url");

const callCallback = (
  query: Record<string, string> = { state: "STATE1", code: "CODE1" },
  cookie: string | null = cookieValue(),
) => {
  const url = new URL("http://internal:3000/api/cockpit/gmail/callback");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return callback(
    new NextRequest(url, {
      headers: cookie === null ? {} : { cookie: `${COOKIE_NAME}=${cookie}` },
    }),
  );
};

const location = (res: Response) => res.headers.get("location") ?? "";
const clearsCookie = (res: Response) => {
  const c = res.headers.get("set-cookie") ?? "";
  return c.startsWith(`${COOKIE_NAME}=;`) && /Max-Age=0/i.test(c) && /Path=\/api\/cockpit\/gmail/.test(c);
};
const fetchedUrls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.stubEnv("COCKPIT_ENABLED", "true");
  vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret-placeholder");
  vi.stubEnv("GOOGLE_REDIRECT_URI", REDIRECT);
  vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", ALLOWED);
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) =>
    String(url).includes("/revoke")
      ? new Response("{}", { status: 200 })
      : tokenResponse(),
  );
  authMock.mockResolvedValue({ user: { id: "u1" } });
  findAccount.mockReset().mockResolvedValue(null);
  upsert.mockReset().mockResolvedValue({ id: "g1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("connect (AC-22)", () => {
  it("sets the state cookie and redirects to Google with PKCE and the send scope", async () => {
    const res = await connect();
    expect(res.status).toBe(302);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Path=\/api\/cockpit\/gmail/);
    expect(setCookie).toMatch(/Max-Age=600/);
    expect(setCookie).toMatch(/Secure/); // redirect URI is https

    const url = new URL(location(res));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("scope")).toBe(`${SEND} openid email`);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("redirect_uri")).toBe(REDIRECT);
    expect(q.get("client_id")).toBe(CLIENT_ID);

    const raw = res.cookies.get(COOKIE_NAME)?.value;
    const payload = decodeCookie(raw);
    expect(payload).toMatchObject({ userId: "u1" });
    expect(payload?.state).toBe(q.get("state"));
    expect(payload?.nonce).toBe(q.get("nonce"));
    expect(q.get("code_challenge")).toBe(
      createHash("sha256").update(payload!.verifier).digest("base64url"),
    );
    expect(payload!.state.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
  });

  it("omits Secure when the redirect URI is http", async () => {
    vi.stubEnv("GOOGLE_REDIRECT_URI", "http://localhost:3737/api/cockpit/gmail/callback");
    const res = await connect();
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/Secure/);
  });

  it("flag off → 404 before auth; no session → 401; not configured → settings error", async () => {
    vi.stubEnv("COCKPIT_ENABLED", "false");
    authMock.mockClear();
    expect((await connect()).status).toBe(404);
    expect(authMock).not.toHaveBeenCalled();

    vi.stubEnv("COCKPIT_ENABLED", "true");
    authMock.mockResolvedValueOnce(null);
    expect((await connect()).status).toBe(401);

    vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", "");
    const res = await connect();
    expect(location(res)).toBe(
      "https://cockpit.example.test/dashboard/review/settings?error=not_configured",
    );
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("callback (AC-23)", () => {
  it("success: stores the refresh token encrypted, redirects on the configured origin, deletes the cookie", async () => {
    const res = await callCallback();
    expect(location(res)).toBe(
      "https://cockpit.example.test/dashboard/review/settings?connected=1",
    );
    expect(clearsCookie(res)).toBe(true);

    const exchange = fetchMock.mock.calls[0];
    expect(String(exchange[0])).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(exchange[1].body as string);
    expect(body.get("code_verifier")).toBe("VERIFIER1");
    expect(body.get("grant_type")).toBe("authorization_code");

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.create.userId).toBe("u1");
    expect(arg.create.email).toBe(ALLOWED);
    expect(arg.create.scopes).toBe(`${SEND} openid email`);
    expect(JSON.stringify(arg)).not.toContain("refresh-new");
    expect(decrypt(arg.create.encryptedRefreshToken, arg.create.iv)).toBe("refresh-new");
    expect(arg.select).toEqual({ id: true });
  });

  it("revokes the previous refresh token before replacing it", async () => {
    const old = encrypt("refresh-old");
    findAccount.mockResolvedValue({ encryptedRefreshToken: old.encrypted, iv: old.iv });
    const res = await callCallback();
    expect(location(res)).toContain("connected=1");

    const revokeCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/revoke"));
    expect(new URLSearchParams(revokeCall![1].body as string).get("token")).toBe("refresh-old");
    expect(fetchedUrls().findIndex((u) => u.includes("/revoke"))).toBeGreaterThan(
      fetchedUrls().findIndex((u) => u.includes("/token")),
    );
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("still stores the new token when revoking the old one fails", async () => {
    const old = encrypt("refresh-old");
    findAccount.mockResolvedValue({ encryptedRefreshToken: old.encrypted, iv: old.iv });
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/revoke")
        ? new Response("{}", { status: 400 })
        : tokenResponse(),
    );
    expect(location(await callCallback())).toContain("connected=1");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("accepts email_verified as the string \"true\"", async () => {
    fetchMock.mockResolvedValue(tokenResponse({}, { email_verified: "true" }));
    expect(location(await callCallback())).toContain("connected=1");
  });

  it("accepts the bare accounts.google.com issuer and a case-different address", async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({}, { iss: "accounts.google.com", email: "You@Example.com" }),
    );
    expect(location(await callCallback())).toContain("connected=1");
  });

  const rejections: [string, () => Promise<Response>, string][] = [
    ["a missing state cookie", () => callCallback(undefined, null), "invalid_state"],
    ["a missing state parameter", () => callCallback({ code: "CODE1" }), "invalid_state"],
    ["a wrong state", () => callCallback({ state: "OTHER1", code: "CODE1" }), "invalid_state"],
    ["a malformed cookie", () => callCallback(undefined, "not-json"), "invalid_state"],
    [
      "a cookie of another user",
      () => callCallback(undefined, cookieValue({ ...COOKIE, userId: "u2" })),
      "session_mismatch",
    ],
    ["a Google error", () => callCallback({ state: "STATE1", error: "access_denied" }), "access_denied"],
  ];
  it.each(rejections)("rejects %s without any Google call and deletes the cookie", async (_n, run, code) => {
    const res = await run();
    expect(location(res)).toBe(
      `https://cockpit.example.test/dashboard/review/settings?error=${code}`,
    );
    expect(clearsCookie(res)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("checks state before ?error=: a bad state with an error reports invalid_state", async () => {
    const res = await callCallback({ state: "WRONG", error: "access_denied" });
    expect(location(res)).toContain("error=invalid_state");
  });

  it("checks ENCRYPTION_KEY before the code exchange", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    const res = await callCallback();
    expect(location(res)).toContain("error=encryption_unavailable");
    expect(clearsCookie(res)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const afterExchange: [string, Response, string][] = [
    ["a missing refresh_token", tokenResponse({ refresh_token: undefined }), "no_refresh_token"],
    ["a wrong aud", tokenResponse({}, { aud: "other.example.test" }), "bad_id_token"],
    ["a wrong iss", tokenResponse({}, { iss: "https://evil.example.test" }), "bad_id_token"],
    ["an expired id_token", tokenResponse({}, { exp: Math.floor(Date.now() / 1000) - 5 }), "bad_id_token"],
    ["a nonce mismatch", tokenResponse({}, { nonce: "N2" }), "bad_id_token"],
    ["a missing id_token", tokenResponse({ id_token: undefined }), "bad_id_token"],
    ["an unverified email", tokenResponse({}, { email_verified: false }), "email_unverified"],
    ["a missing gmail.send scope", tokenResponse({ scope: "openid email" }), "missing_scope"],
    ["a non-allowed address", tokenResponse({}, { email: "someone@example.com" }), "address_not_allowed"],
    ["a token endpoint failure", new Response("{}", { status: 400 }), "token_exchange_failed"],
  ];
  it.each(afterExchange)("rejects %s, stores nothing and deletes the cookie", async (_n, response, code) => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/revoke") ? new Response("{}", { status: 200 }) : response.clone(),
    );
    const res = await callCallback();
    expect(location(res)).toBe(
      `https://cockpit.example.test/dashboard/review/settings?error=${code}`,
    );
    expect(clearsCookie(res)).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("revokes the just-issued token when it refuses to store it", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/revoke")
        ? new Response("{}", { status: 200 })
        : tokenResponse({}, { email: "someone@example.com" }),
    );
    await callCallback();
    const revokeCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/revoke"));
    expect(new URLSearchParams(revokeCall![1].body as string).get("token")).toBe("refresh-new");
  });

  it("flag off → 404, no session → 401, both delete the cookie", async () => {
    vi.stubEnv("COCKPIT_ENABLED", "false");
    const off = await callCallback();
    expect(off.status).toBe(404);
    expect(clearsCookie(off)).toBe(true);

    vi.stubEnv("COCKPIT_ENABLED", "true");
    authMock.mockResolvedValueOnce(null);
    const anon = await callCallback();
    expect(anon.status).toBe(401);
    expect(clearsCookie(anon)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a database failure maps to a coded redirect, not a thrown 500, and keeps the secret out", async () => {
    upsert.mockRejectedValue(new Error("db exploded refresh-new"));
    const res = await callCallback();
    expect(location(res)).toContain("error=token_exchange_failed");
    expect(location(res)).not.toContain("refresh-new");
    expect(clearsCookie(res)).toBe(true);
  });
});
