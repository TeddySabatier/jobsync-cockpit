import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/db";
import { isCockpitEnabled } from "@/lib/cockpit/config";
import { COCKPIT_ERROR_MESSAGES } from "@/lib/cockpit/errors";
import { renderLetterPdf } from "@/lib/cockpit/letterPdf";
import { letterAttachmentName } from "@/lib/cockpit/attachments";

// Cover-letter PDF of one of the user's packages, made from the current letter
// text (D-015). The same function builds the attachment at Send, so this is the
// exact file the recipient gets. Order: flag (404) -> session (401) -> ownership (404).
const notFound = () => new NextResponse(null, { status: 404 });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ packageId: string }> },
) {
  if (!isCockpitEnabled()) return notFound();

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      {
        success: false,
        code: "UNAUTHENTICATED",
        message: COCKPIT_ERROR_MESSAGES.UNAUTHENTICATED,
      },
      { status: 401 },
    );
  }

  const { packageId } = await params;
  // The userId in the where clause is the ownership check.
  const pkg = await prisma.applicationPackage.findFirst({
    where: { id: packageId, userId },
    select: { letterMd: true, cvJson: true, cvFile: { select: { fileName: true } } },
  });
  if (!pkg?.letterMd?.trim()) return notFound();

  let pdf: Buffer;
  try {
    pdf = await renderLetterPdf({ letterMd: pkg.letterMd, cvJson: pkg.cvJson });
  } catch {
    return new NextResponse(null, { status: 500 });
  }
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.length),
      // The name the recipient gets, so a saved copy matches the email.
      "Content-Disposition": `inline; filename="${letterAttachmentName(pkg.cvFile?.fileName)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; frame-ancestors 'self'",
    },
  });
}
