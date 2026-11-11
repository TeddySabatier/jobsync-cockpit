import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isCockpitEnabled } from "./config";
import { COCKPIT_ERROR_MESSAGES } from "./errors";

// Shared preamble of the cockpit HTTP routes. Order: flag (404, before auth is
// consulted) -> session (401). The middleware already redirects anonymous
// requests to /signin (D-011 a), so the 401 only answers a session that has
// no user id; it stays as the single defence in depth.
export type CockpitUserResult =
  | { userId: string; response?: undefined }
  | { userId?: undefined; response: NextResponse };

export async function requireCockpitUser(): Promise<CockpitUserResult> {
  if (!isCockpitEnabled()) {
    return { response: new NextResponse(null, { status: 404 }) };
  }
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return {
      response: NextResponse.json(
        {
          success: false,
          code: "UNAUTHENTICATED",
          message: COCKPIT_ERROR_MESSAGES.UNAUTHENTICATED,
        },
        { status: 401 },
      ),
    };
  }
  return { userId };
}

// One CSP value, set by the PDF routes only: sandbox isolates scripts inside
// the PDF, frame-ancestors 'self' allows our own iframe.
export const PDF_CSP = "sandbox; frame-ancestors 'self'";

// Headers of both PDF routes (CV and cover letter). private, no-store: the
// bytes belong to one signed-in user and must not sit in a shared cache.
export function pdfHeaders(
  fileName: string,
  length: number,
): Record<string, string> {
  return {
    "Content-Type": "application/pdf",
    "Content-Length": String(length),
    "Content-Disposition": `inline; filename="${fileName}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": PDF_CSP,
  };
}
