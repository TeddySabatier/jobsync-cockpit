import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { exchangeAuthCode, revokeToken } from "@/lib/cockpit/gmail/client";
import {
  COOKIE_NAME,
  OAuthError,
  SETTINGS_PATH,
  assertScopeAndAddress,
  cookieAttributes,
  decodeCookie,
  getGoogleConfig,
  redirectLocation,
  safeEqual,
  verifyIdToken,
} from "@/lib/cockpit/gmail/oauth";
import { requireCockpitUser } from "@/lib/cockpit/route";
import { decrypt, encrypt } from "@/lib/encryption";
import { log } from "@/lib/telemetry";

// Finishes the Gmail OAuth flow (cockpit/SPEC.md §6.2). Every exit path goes
// through finish(), which deletes the state cookie.

async function quietly(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    // Best effort; the typed error was already logged (code and status only).
  }
}

export async function GET(req: NextRequest) {
  const cookieRaw = req.cookies.get(COOKIE_NAME)?.value;
  const secure =
    getGoogleConfig()?.secure ??
    (process.env.GOOGLE_REDIRECT_URI ?? "").startsWith("https:");

  const finish = (res: NextResponse) => {
    res.cookies.set(COOKIE_NAME, "", {
      ...cookieAttributes(secure),
      maxAge: 0,
    });
    return res;
  };
  const redirect = (query: string) =>
    finish(
      new NextResponse(null, {
        status: 302,
        headers: { Location: redirectLocation(`${SETTINGS_PATH}?${query}`) },
      }),
    );

  const user = await requireCockpitUser();
  if (user.response) return finish(user.response);
  const { userId } = user;

  // The new refresh token, once Google has issued it; revoked if we then
  // refuse to store it, so it is not left alive at Google.
  let unstoredToken: string | undefined;
  try {
    const cfg = getGoogleConfig();
    if (!cfg) throw new OAuthError("not_configured");

    // State first, before anything Google put in the query string.
    const params = req.nextUrl.searchParams;
    const cookie = decodeCookie(cookieRaw);
    const state = params.get("state");
    if (!cookie || !state || !safeEqual(state, cookie.state)) {
      throw new OAuthError("invalid_state");
    }
    if (cookie.userId !== userId) throw new OAuthError("session_mismatch");

    if (params.get("error")) throw new OAuthError("access_denied");
    const code = params.get("code");
    if (!code) throw new OAuthError("token_exchange_failed");

    // Before the exchange, so a refresh token is never left unstored.
    if (!process.env.ENCRYPTION_KEY) throw new OAuthError("encryption_unavailable");

    const tokens = await exchangeAuthCode(cfg, code, cookie.verifier);
    if (!tokens.refreshToken) throw new OAuthError("no_refresh_token");
    unstoredToken = tokens.refreshToken;

    const { email } = verifyIdToken(tokens.idToken, cfg, cookie.nonce);
    assertScopeAndAddress(email, tokens.scope, cfg);

    // Same client + account share one Google grant, and revoking any token
    // revokes the grant, so a same-email reconnect must not revoke (D-010).
    // Only a different account is a different grant: revoke its old token,
    // read with an explicit select.
    const existing = await prisma.gmailAccount.findUnique({
      where: { userId },
      select: { email: true },
    });
    if (existing && existing.email.toLowerCase() !== email.toLowerCase()) {
      const old = await prisma.gmailAccount.findUnique({
        where: { userId },
        select: { encryptedRefreshToken: true, iv: true },
      });
      if (old) {
        await quietly(() =>
          revokeToken(decrypt(old.encryptedRefreshToken, old.iv)),
        );
      }
    }

    const { encrypted, iv } = encrypt(tokens.refreshToken);
    const data = {
      email,
      encryptedRefreshToken: encrypted,
      iv,
      scopes: tokens.scope as string,
    };
    await prisma.gmailAccount.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
      select: { id: true },
    });
    unstoredToken = undefined;
    return redirect("connected=1");
  } catch (e) {
    if (unstoredToken) {
      const token = unstoredToken;
      // With a stored connection the new token may share its grant, and
      // revoking it would kill the working connection (D-010). If the lookup
      // itself fails, do not revoke.
      await quietly(async () => {
        const stored = await prisma.gmailAccount.findUnique({
          where: { userId },
          select: { id: true },
        });
        if (!stored) await revokeToken(token);
      });
    }
    const code = e instanceof OAuthError ? e.code : "token_exchange_failed";
    // Code only: never the error text, tokens or Google's response.
    log.warn("cockpit: gmail oauth failed", { code });
    return redirect(`error=${code}`);
  }
}
