import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { notFound, pdfHeaders, requireCockpitUser } from "@/lib/cockpit/route";
import { log } from "@/lib/telemetry";
import { renderLetterPdf } from "@/lib/cockpit/letterPdf";
import { letterAttachmentName } from "@/lib/cockpit/attachments";

// Cover-letter PDF of one of the user's packages, made from the current letter
// text (D-015). The same function builds the attachment at Send, so this is the
// exact file the recipient gets. Order: flag (404) -> session (401) -> ownership (404).

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ packageId: string }> },
) {
  const user = await requireCockpitUser();
  if (user.response) return user.response;
  const { userId } = user;

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
    // Code only: the error text may quote the letter.
    log.warn("cockpit: letter pdf render failed", { code: "LETTER_RENDER_FAILED" });
    return new NextResponse(null, { status: 500 });
  }
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    // The name the recipient gets, so a saved copy matches the email.
    headers: pdfHeaders(letterAttachmentName(pkg.cvFile?.fileName), pdf.length),
  });
}
