"use strict";
// Preload (NODE_OPTIONS=--require) for the cockpit E2E dev server ONLY.
// Wraps globalThis.fetch so no request ever reaches a Google host:
//   - oauth2.googleapis.com/token, /revoke and
//     gmail.googleapis.com/gmail/v1/users/me/messages/send are answered here;
//   - any OTHER request to a Google host throws;
//   - everything else goes to the real fetch.
// Behaviour is chosen per request from <tmp>/fake-google.mode (JSON, re-read
// every time):
//   { send: "ok"|"400"|"401"|"403"|"429"|"500"|"timeout"|"network"|"badbody",
//     token: "ok"|"invalid_grant", revoke: "ok"|"500", delayMs: number }
// Every request is appended to <tmp>/fake-google.log as one JSON line, with
// tokens, secrets and authorization redacted; send requests carry the decoded
// To / Subject / attachment name from the raw MIME.
//
// Requests are VALIDATED, not just answered (a rejected one gets a Google-style
// 4xx and is logged with `rejected: <reason>`):
//   - authorization_code: client_id, client_secret and redirect_uri must be the
//     configured ones, code_verifier must be present and look like an RFC 7636
//     verifier and, when the code carries a `challenge` (connectGmail copies it
//     from the redirect to Google), SHA-256(verifier) must equal it (PKCE);
//   - refresh_token: client_id, client_secret and the refresh token must match;
//   - revoke: the token must be the refresh token;
//   - send: Authorization must be the Bearer access token the fake handed out.
//
// The authorization-code "code" is a test seam: "fc_" + base64url(JSON) with
// { nonce, challenge?, email?, emailVerified?, scope?, refreshToken?, aud?, expOffsetS? }.
// The fake token endpoint turns it into an unsigned id_token (the app does not
// verify signatures, only aud/iss/exp/nonce).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const tmpDir =
  process.env.COCKPIT_E2E_TMP || path.join(process.cwd(), ".cockpit-tmp");
const modeFile = path.join(tmpDir, "fake-google.mode");
const logFile = path.join(tmpDir, "fake-google.log");

const GOOGLE_HOST = /(^|\.)(google|googleapis|gstatic|googleusercontent|gmail)\.com$/i;
const b64url = (s) => Buffer.from(s).toString("base64url");

// What the app is configured with (cockpit-server.mjs sets the env).
const EXPECTED = {
  clientId: process.env.GOOGLE_CLIENT_ID || "fake-client-id",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || "fake-client-secret",
  redirectUri: process.env.GOOGLE_REDIRECT_URI || null,
};
const ACCESS_TOKEN = "fake-access-token";
const REFRESH_TOKEN = "fake-refresh-token";

function readMode() {
  const defaults = { send: "ok", token: "ok", revoke: "ok", delayMs: 0 };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(modeFile, "utf8")) };
  } catch {
    return defaults;
  }
}

function log(entry) {
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.appendFileSync(
      logFile,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch {
    // Logging must never break a request.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function decodeWord(s) {
  return s.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_m, b) =>
    Buffer.from(b, "base64").toString("utf8"),
  );
}

// Pulls what tests assert on out of the raw RFC 5322 text. Never logs the body.
function describeMime(raw) {
  let text;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return { mimeError: "undecodable" };
  }
  const headerEnd = text.indexOf("\r\n\r\n");
  const head = (headerEnd === -1 ? text : text.slice(0, headerEnd)).replace(
    /\r\n[ \t]+/g,
    " ",
  );
  const header = (name) => {
    const m = head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "im"));
    return m ? decodeWord(m[1].trim()) : null;
  };
  // Every attachment part, in order: name from Content-Disposition, size from
  // the base64 body that follows the part headers.
  const attachments = [];
  const partRe =
    /Content-Disposition:\s*attachment;\s*filename="([^"]*)"[^\r\n]*\r\n(?:[^\r\n]+\r\n)*?\r\n([A-Za-z0-9+/=\r\n]*)/gi;
  let m;
  while ((m = partRe.exec(text))) {
    attachments.push({
      name: m[1],
      bytes: Buffer.from(m[2].replace(/\s+/g, ""), "base64").length,
    });
  }
  return {
    from: header("From"),
    to: header("To"),
    subject: header("Subject"),
    // attachmentName / attachmentBytes describe the FIRST attachment.
    attachmentName: attachments[0] ? attachments[0].name : null,
    attachmentBytes: attachments[0] ? attachments[0].bytes : null,
    attachments,
    mimeBytes: text.length,
  };
}

function fakeIdToken(clientId, spec) {
  const claims = {
    iss: "https://accounts.google.com",
    aud: spec.aud ?? clientId,
    exp: Math.floor(Date.now() / 1000) + (spec.expOffsetS ?? 3600),
    iat: Math.floor(Date.now() / 1000),
    nonce: spec.nonce,
    email: spec.email ?? "you@example.com",
    email_verified: spec.emailVerified ?? true,
    sub: "fake-sub",
  };
  return [
    b64url(JSON.stringify({ alg: "none", typ: "JWT" })),
    b64url(JSON.stringify(claims)),
    "fake-signature",
  ].join(".");
}

function parseCode(code) {
  if (typeof code !== "string" || !code.startsWith("fc_")) return {};
  try {
    return JSON.parse(Buffer.from(code.slice(3), "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

async function bodyText(input, init) {
  const b = init && init.body;
  if (typeof b === "string") return b;
  if (b instanceof URLSearchParams) return b.toString();
  if (typeof Request !== "undefined" && input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return "";
    }
  }
  return "";
}

let sendCounter = 0;

// Returns a reason when the app sent something Google would refuse.
function tokenProblem(form, grant, spec) {
  if (form.get("client_id") !== EXPECTED.clientId) return "client_id mismatch";
  if (form.get("client_secret") !== EXPECTED.clientSecret) return "client_secret mismatch";
  if (grant === "authorization_code") {
    const verifier = form.get("code_verifier");
    if (!verifier) return "code_verifier missing";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return "code_verifier malformed";
    if (spec.challenge) {
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (challenge !== spec.challenge) return "code_verifier does not match code_challenge";
    }
    const redirect = form.get("redirect_uri");
    if (!redirect) return "redirect_uri missing";
    if (EXPECTED.redirectUri && redirect !== EXPECTED.redirectUri) return "redirect_uri mismatch";
    return null;
  }
  if (grant === "refresh_token") {
    if (form.get("refresh_token") !== REFRESH_TOKEN) return "refresh_token mismatch";
    return null;
  }
  return `unsupported grant_type ${grant}`;
}

async function handleToken(form, mode) {
  const grant = form.get("grant_type");
  // Only key names are logged: values hold codes, secrets and refresh tokens.
  const entry = { kind: "token", grant, fields: [...form.keys()] };
  if (mode.token === "invalid_grant") {
    log({ ...entry, status: 400, mode: "invalid_grant" });
    return json(400, { error: "invalid_grant" });
  }
  const spec = grant === "authorization_code" ? parseCode(form.get("code")) : {};
  const problem = tokenProblem(form, grant, spec);
  if (problem) {
    log({ ...entry, status: 400, mode: "rejected", rejected: problem });
    return json(400, { error: "invalid_request", error_description: problem });
  }
  if (grant === "authorization_code") {
    const scope =
      spec.scope ??
      "https://www.googleapis.com/auth/gmail.send openid https://www.googleapis.com/auth/userinfo.email";
    const out = {
      access_token: ACCESS_TOKEN,
      expires_in: 3599,
      scope,
      token_type: "Bearer",
      id_token: fakeIdToken(form.get("client_id"), spec),
    };
    if (spec.refreshToken !== false) out.refresh_token = REFRESH_TOKEN;
    log({ ...entry, status: 200, mode: "ok" });
    return json(200, out);
  }
  log({ ...entry, status: 200, mode: "ok" });
  return json(200, {
    access_token: ACCESS_TOKEN,
    expires_in: 3599,
    scope: "https://www.googleapis.com/auth/gmail.send",
    token_type: "Bearer",
  });
}

function headerOf(input, init, name) {
  const h = (init && init.headers) || (typeof Request !== "undefined" && input instanceof Request ? input.headers : null);
  if (!h) return null;
  if (typeof h.get === "function") return h.get(name);
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : null;
}

async function handleSend(input, init, mode) {
  let raw = "";
  try {
    raw = JSON.parse(await bodyText(input, init)).raw ?? "";
  } catch {
    // Malformed body: logged without MIME details.
  }
  const entry = {
    kind: "send",
    mode: mode.send,
    authorization: "[redacted]",
    ...describeMime(raw),
  };

  if (headerOf(input, init, "authorization") !== `Bearer ${ACCESS_TOKEN}`) {
    log({ ...entry, status: 401, outcome: "rejected", rejected: "bad Authorization" });
    return json(401, { error: { code: 401, message: "FAKE-GOOGLE-BODY-MARKER" } });
  }

  if (mode.send === "timeout") {
    // Hang until the caller's AbortSignal fires (the real 20 s client timeout),
    // or until delayMs for a fast variant.
    const signal = init && init.signal;
    await new Promise((_resolve, reject) => {
      const fail = () => {
        log({ ...entry, outcome: "timeout" });
        reject(
          signal && signal.reason
            ? signal.reason
            : new DOMException("The operation timed out", "TimeoutError"),
        );
      };
      if (signal && signal.aborted) return fail();
      if (signal) signal.addEventListener("abort", fail, { once: true });
      if (mode.delayMs > 0) setTimeout(fail, mode.delayMs);
    });
  }
  if (mode.delayMs > 0) await sleep(mode.delayMs);

  if (mode.send === "network") {
    log({ ...entry, outcome: "network" });
    throw new TypeError("fetch failed");
  }
  if (mode.send === "badbody") {
    log({ ...entry, status: 200, outcome: "badbody" });
    return new Response("<html>not json</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }
  if (/^\d{3}$/.test(mode.send) && mode.send !== "200") {
    const status = Number(mode.send);
    log({ ...entry, status, outcome: "error" });
    // The body echoes a marker so tests can assert it never reaches the UI.
    return json(status, { error: { code: status, message: "FAKE-GOOGLE-BODY-MARKER" } });
  }
  sendCounter += 1;
  log({ ...entry, status: 200, outcome: "sent" });
  return json(200, { id: `fake-msg-${sendCounter}`, threadId: `fake-thread-${sendCounter}` });
}

const realFetch = globalThis.fetch;

globalThis.fetch = async function fakeGoogleFetch(input, init) {
  let url;
  try {
    url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  } catch {
    return realFetch.call(this, input, init);
  }
  if (!GOOGLE_HOST.test(url.hostname)) return realFetch.call(this, input, init);

  const mode = readMode();
  const target = url.origin + url.pathname;
  // Send applies delayMs itself (it has the timeout variant).
  if (mode.delayMs > 0 && !target.endsWith("/messages/send")) await sleep(mode.delayMs);

  if (target === "https://oauth2.googleapis.com/token") {
    const form = new URLSearchParams(await bodyText(input, init));
    return handleToken(form, mode);
  }
  if (target === "https://oauth2.googleapis.com/revoke") {
    const token = new URLSearchParams(await bodyText(input, init)).get("token");
    if (token !== REFRESH_TOKEN) {
      log({ kind: "revoke", status: 400, rejected: "token mismatch" });
      return json(400, { error: "invalid_token" });
    }
    log({ kind: "revoke", status: mode.revoke === "500" ? 500 : 200 });
    return mode.revoke === "500" ? json(500, {}) : json(200, {});
  }
  if (target === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
    return handleSend(input, init, mode);
  }

  log({ kind: "blocked", host: url.hostname, path: url.pathname });
  throw new Error(`fake-google: blocked request to ${url.hostname}`);
};
