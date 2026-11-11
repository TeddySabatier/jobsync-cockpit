import { NextResponse } from "next/server";
import { requireCockpitUser } from "@/lib/cockpit/route";
import {
  COOKIE_MAX_AGE_SECONDS,
  COOKIE_NAME,
  SETTINGS_PATH,
  buildAuthUrl,
  cookieAttributes,
  createOAuthParams,
  encodeCookie,
  getGoogleConfig,
  redirectLocation,
} from "@/lib/cockpit/gmail/oauth";

// Starts the Gmail OAuth flow (cockpit/SPEC.md §6.2). Order: flag (404) ->
// session (401) -> config.
const redirect = (location: string) =>
  new NextResponse(null, { status: 302, headers: { Location: location } });

export async function GET() {
  const user = await requireCockpitUser();
  if (user.response) return user.response;
  const { userId } = user;

  const cfg = getGoogleConfig();
  if (!cfg) {
    return redirect(redirectLocation(`${SETTINGS_PATH}?error=not_configured`));
  }

  const { payload, challenge } = createOAuthParams(userId);
  const res = redirect(buildAuthUrl(cfg, payload, challenge));
  res.cookies.set(COOKIE_NAME, encodeCookie(payload), {
    ...cookieAttributes(cfg.secure),
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}
