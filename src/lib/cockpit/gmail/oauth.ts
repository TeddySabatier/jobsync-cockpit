import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { isGmailSendAllowed } from "../config";

// Gmail OAuth helpers (cockpit/SPEC.md §6.2): config, PKCE, state cookie,
// id_token checks and the fixed error enum. No network here; Google calls live
// in ./client.ts.

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_SCOPES = `${GMAIL_SEND_SCOPE} openid email`;
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export const SETTINGS_PATH = "/dashboard/review/settings";
export const COOKIE_NAME = "cockpit_gmail_oauth";
export const COOKIE_PATH = "/api/cockpit/gmail";
export const COOKIE_MAX_AGE_SECONDS = 600;

const DEFAULT_REDIRECT_URI = "http://localhost:3737/api/cockpit/gmail/callback";

export const OAUTH_ERROR_MESSAGES = {
  invalid_state: "The Gmail connection attempt expired or was invalid. Try again.",
  session_mismatch: "You were signed out or switched account during the Gmail connection. Try again.",
  access_denied: "Google did not grant access.",
  no_refresh_token: "Google did not return a refresh token. Try again.",
  bad_id_token: "Google's identity token could not be verified.",
  email_unverified: "The Google account's email address is not verified.",
  missing_scope: "The permission to send email was not granted.",
  address_not_allowed: "This Google account is not the address allowed for the cockpit.",
  not_configured: "Gmail is not configured on the server.",
  encryption_unavailable: "The server has no usable encryption key, so a Gmail token cannot be stored.",
  token_exchange_failed: "Google rejected the connection. Try again.",
} as const;

export type OAuthErrorCode = keyof typeof OAUTH_ERROR_MESSAGES;

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  constructor(code: OAuthErrorCode) {
    super(OAUTH_ERROR_MESSAGES[code]);
    this.name = "OAuthError";
    this.code = code;
  }
}

const GENERIC_ERROR = "Gmail could not be connected.";

// The raw query value is never printed: only a known code maps to a message.
export function oauthErrorMessage(raw: unknown): string {
  return typeof raw === "string" &&
    Object.prototype.hasOwnProperty.call(OAUTH_ERROR_MESSAGES, raw)
    ? OAUTH_ERROR_MESSAGES[raw as OAuthErrorCode]
    : GENERIC_ERROR;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  // Scheme + host of GOOGLE_REDIRECT_URI: the only base for our redirects.
  origin: string;
  secure: boolean;
  allowedAddress: string;
}

const REQUIRED_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "COCKPIT_GMAIL_ALLOWED_ADDRESS",
] as const;

function redirectUri(): string {
  return process.env.GOOGLE_REDIRECT_URI || DEFAULT_REDIRECT_URI;
}

function originOf(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

// Names of the unset env vars (names only, never values).
export function missingGmailEnv(): string[] {
  const missing: string[] = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (!originOf(redirectUri())) missing.push("GOOGLE_REDIRECT_URI");
  return missing;
}

export function getGoogleConfig(): GoogleConfig | null {
  if (missingGmailEnv().length > 0) return null;
  const uri = redirectUri();
  return {
    clientId: process.env.GOOGLE_CLIENT_ID as string,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    redirectUri: uri,
    origin: originOf(uri) as string,
    secure: uri.startsWith("https:"),
    allowedAddress: process.env.COCKPIT_GMAIL_ALLOWED_ADDRESS as string,
  };
}

// Origin comes from GOOGLE_REDIRECT_URI, never from req.url or Host headers.
// Without a usable origin the Location stays relative.
export function redirectLocation(path: string): string {
  const origin = originOf(redirectUri());
  return origin ? new URL(path, origin).toString() : path;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export interface OAuthCookiePayload {
  state: string;
  verifier: string;
  userId: string;
  nonce: string;
}

export function createOAuthParams(userId: string) {
  const payload: OAuthCookiePayload = {
    state: b64url(randomBytes(32)),
    verifier: b64url(randomBytes(32)),
    userId,
    nonce: b64url(randomBytes(16)),
  };
  const challenge = b64url(createHash("sha256").update(payload.verifier).digest());
  return { payload, challenge };
}

export function buildAuthUrl(
  cfg: GoogleConfig,
  payload: OAuthCookiePayload,
  challenge: string,
): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES,
    state: payload.state,
    nonce: payload.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return url.toString();
}

export const encodeCookie = (p: OAuthCookiePayload) =>
  b64url(Buffer.from(JSON.stringify(p), "utf8"));

export function decodeCookie(raw: string | undefined): OAuthCookiePayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return ["state", "verifier", "userId", "nonce"].every(
      (k) => typeof p?.[k] === "string" && p[k].length > 0,
    )
      ? (p as OAuthCookiePayload)
      : null;
  } catch {
    return null;
  }
}

export function cookieAttributes(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: COOKIE_PATH,
    secure,
  };
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

// Signature verification is skipped on purpose: the id_token came straight
// from Google's token endpoint over TLS in the code exchange, not from the
// browser. aud, iss, exp and nonce are still checked (SPEC §6.2).
export function verifyIdToken(
  idToken: string | undefined,
  cfg: GoogleConfig,
  nonce: string,
  nowMs: number = Date.now(),
): { email: string } {
  let claims: Record<string, unknown>;
  try {
    const part = (idToken ?? "").split(".")[1];
    claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new OAuthError("bad_id_token");
  }
  if (!claims || typeof claims !== "object") throw new OAuthError("bad_id_token");

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !aud.includes(cfg.clientId) ||
    typeof claims.iss !== "string" ||
    !ISSUERS.includes(claims.iss) ||
    typeof claims.exp !== "number" ||
    claims.exp * 1000 <= nowMs ||
    typeof claims.nonce !== "string" ||
    !safeEqual(claims.nonce, nonce)
  ) {
    throw new OAuthError("bad_id_token");
  }
  if (typeof claims.email !== "string" || !claims.email) {
    throw new OAuthError("bad_id_token");
  }
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    throw new OAuthError("email_unverified");
  }
  return { email: claims.email };
}

export function assertScopeAndAddress(
  email: string,
  grantedScope: string | undefined,
  cfg: GoogleConfig,
): void {
  if (!(grantedScope ?? "").split(/\s+/).includes(GMAIL_SEND_SCOPE)) {
    throw new OAuthError("missing_scope");
  }
  if (!isGmailSendAllowed(email, cfg.allowedAddress)) {
    throw new OAuthError("address_not_allowed");
  }
}
