import "server-only";
import { CockpitError, type CockpitErrorCode } from "@/lib/cockpit/errors";
import { getGoogleConfig, type GoogleConfig } from "@/lib/cockpit/gmail/oauth";
import { decrypt } from "@/lib/encryption";
import { log } from "@/lib/telemetry";

// Every Google call goes through googleRequest(): any failure becomes a typed
// CockpitError carrying the HTTP status only. Response bodies, request bodies
// and headers are never logged, thrown or returned (SPEC §6.2, AC-36).

const TIMEOUT_MS = 20_000;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

type Kind = "token" | "revoke" | "send";

export interface GmailClient {
  getAccessToken(refreshToken: string): Promise<string>;
  sendRaw(
    accessToken: string,
    raw: string,
  ): Promise<{ id: string; threadId: string }>;
  revoke(token: string): Promise<void>;
}

function fail(
  kind: Kind,
  code: CockpitErrorCode,
  definitive: boolean,
  status?: number,
): CockpitError {
  log.error("cockpit: google call failed", { kind, code, status: status ?? 0 });
  return new CockpitError(code, { status, definitive });
}

// `send` is the only call where a failure can mean "the message went out";
// token and revoke failures are always definitive. For send, only 400/401/403
// are (SPEC §6.4 5a); timeouts, network errors, 429 and 5xx are ambiguous.
async function googleRequest(
  kind: Kind,
  url: string,
  init: RequestInit,
): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timedOut =
      e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw fail(
      kind,
      timedOut ? "GMAIL_TIMEOUT" : kind === "send" ? "GMAIL_SEND" : "GMAIL_TOKEN",
      kind !== "send",
    );
  }

  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") {
      json = parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON body: handled by the status below.
  }

  if (!res.ok) {
    if (kind === "send") {
      throw fail(
        "send",
        "GMAIL_SEND",
        [400, 401, 403].includes(res.status),
        res.status,
      );
    }
    // Only the `error` code is read, to tell a dead grant from a transient error.
    if (kind === "token" && json.error === "invalid_grant") {
      throw fail(kind, "GMAIL_RECONNECT_REQUIRED", true, res.status);
    }
    throw fail(kind, "GMAIL_TOKEN", true, res.status);
  }
  return { status: res.status, json };
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;

const form = (params: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(params).toString(),
});

// Authorization-code exchange (callback route). The tokens go back to the
// caller only; nothing here logs them.
export async function exchangeAuthCode(
  cfg: GoogleConfig,
  code: string,
  verifier: string,
): Promise<{ refreshToken?: string; idToken?: string; scope?: string }> {
  const { json } = await googleRequest(
    "token",
    TOKEN_URL,
    form({
      code,
      code_verifier: verifier,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  );
  return {
    refreshToken: str(json.refresh_token),
    idToken: str(json.id_token),
    scope: str(json.scope),
  };
}

export async function getAccessToken(refreshToken: string): Promise<string> {
  const cfg = getGoogleConfig();
  if (!cfg) throw fail("token", "GMAIL_TOKEN", true);
  const { json } = await googleRequest(
    "token",
    TOKEN_URL,
    form({
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
    }),
  );
  const token = str(json.access_token);
  if (!token) throw fail("token", "GMAIL_TOKEN", true);
  return token;
}

// decrypt() throws when ENCRYPTION_KEY is missing or changed: the stored token
// is unusable, so the user must reconnect (never a 500; SPEC §6.2).
export async function getAccessTokenFromStored(
  encryptedRefreshToken: string,
  iv: string,
): Promise<string> {
  let refreshToken: string;
  try {
    refreshToken = decrypt(encryptedRefreshToken, iv);
  } catch {
    throw fail("token", "GMAIL_RECONNECT_REQUIRED", true);
  }
  return getAccessToken(refreshToken);
}

export async function revokeToken(token: string): Promise<void> {
  await googleRequest("revoke", REVOKE_URL, form({ token }));
}

// Primitive only: nothing in the connect/disconnect flow calls it. The send
// service (C-10) is its only intended caller.
export async function sendRaw(
  accessToken: string,
  raw: string,
): Promise<{ id: string; threadId: string }> {
  const { json } = await googleRequest("send", SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  const id = str(json.id);
  const threadId = str(json.threadId);
  // A 2xx we cannot read: the message was probably sent, so not definitive.
  if (!id || !threadId) throw fail("send", "GMAIL_SEND", false);
  return { id, threadId };
}

// Safety net: no test can reach Google through the real client (AC-27).
export function createHttpGmailClient(): GmailClient {
  if (process.env.VITEST) {
    throw new Error("createHttpGmailClient is disabled under Vitest");
  }
  return { getAccessToken, sendRaw, revoke: revokeToken };
}
