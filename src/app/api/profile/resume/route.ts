import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import {
  createResumeProfileWith,
  discardResumeUpload,
  editResumeWith,
  storeResumeUpload,
  type StoredUpload,
} from "@/actions/profile/resumeWrite";
import path from "path";
import fsp from "fs/promises";
import { APP_CONSTANTS } from "@/lib/constants";
import { PDF_MAGIC, ZIP_MAGIC } from "@/lib/ai/import/extract-text";
import { log } from "@/lib/telemetry";
import { contentDisposition, safeDownloadName } from "@/lib/downloadName";
import { findDownloadableFile } from "@/lib/uploadedFile";

const ALLOWED_MIME = new Set<string>(APP_CONSTANTS.RESUME_ALLOWED_MIME_TYPES);

// Download types by on-disk extension; any other file is not served.
const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
};

// One answer for every file the user may not download: no body, no reason.
const notFound = () => new NextResponse(null, { status: 404 });

function validateFileBytes(buf: Buffer, mimeType: string): boolean {
  if (mimeType === "application/pdf") return buf.subarray(0, 4).equals(PDF_MAGIC);
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return buf.subarray(0, 4).equals(ZIP_MAGIC);
  }
  return false;
}

export const POST = async (req: NextRequest) => {
  const session = await auth();

  try {
    if (!session || !session.user) {
      return NextResponse.json(
        {
          error: "Not Authenticated",
        },
        {
          status: 401,
        }
      );
    }
    const formData = await req.formData();
    const title = formData.get("title") as string;
    const file = formData.get("file") as File | null;
    const resumeId = (formData.get("id") as string) ?? null;
    const fileId: string | undefined =
      (formData.get("fileId") as string) || undefined;

    // The stored path is made here, server side (issue #78, D-024): no
    // action takes a path from the client.
    let upload: StoredUpload | undefined;
    if (file && file.name && file.size > 0) {
      // Server-side validation: size, MIME type, and magic bytes
      if (file.size > APP_CONSTANTS.MAX_RESUME_FILE_SIZE_BYTES) {
        return NextResponse.json({ error: "File size must be less than 5MB" }, { status: 400 });
      }
      if (!ALLOWED_MIME.has(file.type)) {
        return NextResponse.json({ error: "Only PDF and .docx files are supported" }, { status: 400 });
      }
      const fileBytes = Buffer.from(await file.arrayBuffer());
      if (!validateFileBytes(fileBytes, file.type)) {
        return NextResponse.json({ error: "File content does not match declared type" }, { status: 400 });
      }

      upload = await storeResumeUpload(file);
    }

    // A failed create or edit keeps nothing of the new upload. On an edit the
    // old file (`fileId`) is removed by editResumeWith only after the edit
    // committed, so a failure loses neither the old file nor its row.
    const discardOnFailure = async (result: { success?: boolean } | undefined) => {
      if (upload && !result?.success) await discardResumeUpload(session.user.id, upload);
    };

    if (resumeId && title) {
      const res = await editResumeWith(resumeId, title, fileId, upload);
      await discardOnFailure(res);
      return NextResponse.json(res, { status: 200 });
    }

    const response = await createResumeProfileWith(title, upload);
    await discardOnFailure(response);
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    // A fixed message: the error text can carry a path. The log carries a
    // code (and the errno code, never a message).
    log.error("[Resume] Upload failed", {
      code: "RESUME_UPLOAD_FAILED",
      errno: String((error as NodeJS.ErrnoException)?.code ?? "none"),
    });
    return NextResponse.json(
      { error: "Resume update or File upload failed" },
      { status: 500 },
    );
  }
};

export const GET = async (req: NextRequest) => {
  const session = await auth();
  const userId = session?.user?.id;

  try {
    if (!session || !session.user || !userId) {
      return NextResponse.json(
        {
          error: "Not Authenticated",
        },
        {
          status: 401,
        }
      );
    }

    // Issue #78 (D-024): the request names a File id, never a path. The row
    // is looked up for this user and its stored path is confined to the
    // uploads dir; anything else is the same empty 404.
    const fileId = new URL(req.url).searchParams.get("fileId");
    const file = await findDownloadableFile(userId, fileId);
    if (!file) return notFound();

    const contentType = CONTENT_TYPES[path.extname(file.realPath).toLowerCase()];
    if (!contentType) return notFound();

    const fileContent = await fsp.readFile(file.realPath);

    // The display name (File.fileName): a restored backup names files
    // <id>.<ext> on disk (D-017). Sanitized for the header.
    const onDisk = path.basename(file.realPath).replace(/[\r\n"]/g, "_");
    const safeFileName = safeDownloadName(file.fileName, onDisk);
    return new NextResponse(new Uint8Array(fileContent), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": contentDisposition(safeFileName),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    // A file removed after the check is still "not found"; any other error
    // is logged and answered without its message (it can carry a path).
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return notFound();
    log.error("[Resume] File download failed", { error: String(error) });
    return NextResponse.json({ error: "File download failed" }, { status: 500 });
  }
};
