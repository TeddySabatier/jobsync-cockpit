import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/db";
import { isCockpitEnabled } from "@/lib/cockpit/config";
import { COCKPIT_ERROR_MESSAGES } from "@/lib/cockpit/errors";
import { resolveCockpitFile } from "@/lib/cockpit/files";

// Serves the CV PDF of one of the user's packages (cockpit/SPEC.md §4).
// Order: flag (404) -> session (401) -> ownership + confinement (404).
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
    select: { cvFile: { select: { filePath: true } } },
  });
  if (!pkg?.cvFile) return notFound();

  const real = await resolveCockpitFile(userId, pkg.cvFile);
  if (!real) return notFound();

  let size: number;
  try {
    size = (await fs.stat(real)).size;
  } catch {
    return notFound();
  }

  // The generated on-disk name (<uuid>.pdf), never the stored fileName.
  const name = path.basename(real).replace(/[\r\n"]/g, "_");
  return new NextResponse(
    Readable.toWeb(createReadStream(real)) as ReadableStream,
    {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(size),
        "Content-Disposition": `inline; filename="${name}"`,
        "X-Content-Type-Options": "nosniff",
        // One value, set here only: sandbox isolates scripts inside the PDF,
        // frame-ancestors 'self' allows our own <iframe>.
        "Content-Security-Policy": "sandbox; frame-ancestors 'self'",
      },
    },
  );
}
