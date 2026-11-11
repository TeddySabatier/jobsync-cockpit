// @vitest-environment node
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { buildMimeMessage, encodeRaw } from "@/lib/cockpit/gmail/mime";

// The e2e fake Google (e2e/support/fake-google.cjs) must refuse what the real
// Google would refuse, or e2e passes while the app is broken (a dropped PKCE
// verifier, a wrong client secret). Loaded here as the preload it is, with its
// scratch dir pointed at a temp folder, then driven through the fetch it wraps.
const realFetch = globalThis.fetch;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-google-"));
let fakeFetch: typeof fetch;

const VERIFIER = "v".repeat(43);
const challengeOf = (v: string) => crypto.createHash("sha256").update(v).digest("base64url");
const REDIRECT = "http://localhost:3738/api/cockpit/gmail/callback";

beforeAll(() => {
  process.env.COCKPIT_E2E_TMP = tmp;
  process.env.GOOGLE_CLIENT_ID = "fake-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "fake-client-secret";
  process.env.GOOGLE_REDIRECT_URI = REDIRECT;
  createRequire(import.meta.url)("../../e2e/support/fake-google.cjs");
  fakeFetch = globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const code = (extra: Record<string, unknown> = {}) =>
  "fc_" +
  Buffer.from(
    JSON.stringify({ nonce: "n", challenge: challengeOf(VERIFIER), ...extra }),
  ).toString("base64url");

const exchange = (over: Record<string, string | undefined> = {}) => {
  const fields: Record<string, string | undefined> = {
    code: code(),
    code_verifier: VERIFIER,
    client_id: "fake-client-id",
    client_secret: "fake-client-secret",
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
    ...over,
  };
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.set(k, v);
  return fakeFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
};

describe("fake Google token endpoint", () => {
  it("accepts a well-formed authorization-code exchange", async () => {
    const res = await exchange();
    expect(res.status).toBe(200);
    expect((await res.json()).refresh_token).toBe("fake-refresh-token");
  });

  it("refuses a missing code_verifier (the app dropped PKCE)", async () => {
    const res = await exchange({ code_verifier: undefined });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toBe("code_verifier missing");
  });

  it("refuses a verifier that does not match the code_challenge", async () => {
    expect((await exchange({ code_verifier: "w".repeat(43) })).status).toBe(400);
  });

  it("refuses a malformed verifier", async () => {
    expect((await exchange({ code_verifier: "short" })).status).toBe(400);
  });

  it("refuses a wrong client_secret, client_id and redirect_uri", async () => {
    expect((await exchange({ client_secret: "nope" })).status).toBe(400);
    expect((await exchange({ client_id: "nope" })).status).toBe(400);
    expect((await exchange({ redirect_uri: "http://evil.example/cb" })).status).toBe(400);
    expect((await exchange({ redirect_uri: undefined })).status).toBe(400);
  });

  it("refresh grant needs the issued refresh token and the secret", async () => {
    const refresh = (over: Record<string, string> = {}) =>
      fakeFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "fake-refresh-token",
          client_id: "fake-client-id",
          client_secret: "fake-client-secret",
          ...over,
        }).toString(),
      });
    expect((await refresh()).status).toBe(200);
    expect((await refresh({ refresh_token: "other" })).status).toBe(400);
    expect((await refresh({ client_secret: "other" })).status).toBe(400);
  });

  it("logs the rejection reason and only field names", () => {
    const lines = fs
      .readFileSync(path.join(tmp, "fake-google.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.some((l) => l.rejected === "code_verifier missing")).toBe(true);
    expect(lines.every((l) => !JSON.stringify(l).includes("fake-client-secret"))).toBe(true);
  });
});

describe("fake Google send endpoint", () => {
  const pdf = (n: number) => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(n, 7)]);
  const raw = encodeRaw(
    buildMimeMessage({
      from: "you@example.com",
      to: "jobs@acme.example",
      subject: "Application",
      bodyText: "Hello",
      attachment: { fileName: "cv.pdf", content: pdf(100) },
      extraAttachments: [{ fileName: "letter.pdf", content: pdf(300) }],
    }),
  );
  const send = (authorization?: string) =>
    fakeFetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({ raw }),
    });

  it("refuses a request without the issued Bearer access token", async () => {
    expect((await send()).status).toBe(401);
    expect((await send("Bearer other")).status).toBe(401);
  });

  it("records every attachment, not only the first", async () => {
    expect((await send("Bearer fake-access-token")).status).toBe(200);
    const sent = fs
      .readFileSync(path.join(tmp, "fake-google.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.kind === "send" && l.status === 200)
      .pop();
    expect(sent.attachments).toEqual([
      { name: "cv.pdf", bytes: 109 },
      { name: "letter.pdf", bytes: 309 },
    ]);
    expect(sent.attachmentName).toBe("cv.pdf");
  });
});
