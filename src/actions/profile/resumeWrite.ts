import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import prisma from "@/lib/db";
import { RequireUserError } from "@/lib/authError";
import { log } from "@/lib/telemetry";
import { getTimestampedFileName } from "@/lib/utils";
import { FILE_OUTSIDE_UPLOADS, removeStoredFile, resumesDir } from "@/lib/uploadedFile";
import { createFileEntry, requireUser } from "./shared";

// Not a "use server" module (issue #78, D-024): these functions take a stored
// upload ({ fileName, filePath }), and an exported server action must never
// accept a path from the client. Only the upload route calls them, with a path
// it made itself via storeResumeUpload. The actions in resume.ts wrap them
// without the upload argument.

export type StoredUpload = { fileName: string; filePath: string };

// Thrown for a File id that is not this resume's own file; one message for a
// missing id and someone else's.
const ACCESS_DENIED = "File not found or access denied";
class FileAccessError extends Error {
  constructor() {
    super(ACCESS_DENIED);
  }
}

// The client-facing result of a failure. Only messages this module makes
// itself go out; anything else (a Prisma error can quote the stored path) is
// the caller's fixed message, logged with a code only.
function failure(error: unknown, msg: string) {
  if (error instanceof RequireUserError || error instanceof FileAccessError) {
    return { success: false, message: error.message };
  }
  log.error("[Resume] Write failed", {
    code: "RESUME_WRITE_FAILED",
    errno: String((error as { code?: unknown })?.code ?? "none"),
  });
  return { success: false, message: msg };
}

// Writes an uploaded resume into the resumes dir under a server-made name
// (timestamp + the upload's last path segment, control characters stripped)
// and returns what the File row stores. `wx`: never overwrites a file.
export async function storeResumeUpload(file: File): Promise<StoredUpload> {
  const dir = resumesDir();
  await fs.mkdir(dir, { recursive: true });
  const name = path.basename(getTimestampedFileName(file.name));
  const bytes = new Uint8Array(await file.arrayBuffer());
  let filePath = path.join(dir, name);
  try {
    await fs.writeFile(filePath, bytes, { flag: "wx" });
  } catch (error) {
    // Same name in the same second (two users, a double click): a short
    // random prefix instead of overwriting the other upload.
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    filePath = path.join(dir, `${randomUUID().slice(0, 8)}-${name}`);
    await fs.writeFile(filePath, bytes, { flag: "wx" });
  }
  return { fileName: file.name, filePath };
}

// Removes an upload stored by storeResumeUpload that ended up unused (the
// create or edit failed). Server-made path, still confined.
export async function discardResumeUpload(userId: string, upload: StoredUpload) {
  // A failure after the resume was created (e.g. setting the default) leaves a
  // resume linked to this file: that file stays.
  const linked = await prisma.file
    .findFirst({
      where: { filePath: upload.filePath, Resume: { isNot: null } },
      select: { id: true },
    })
    .catch(() => ({ id: "unknown" }));
  if (linked) return;
  await removeStoredFile(userId, upload.filePath, false).catch(() => undefined);
}

export const createResumeProfileWith = async (
  title: string,
  upload?: StoredUpload,
): Promise<any | undefined> => {
  let createdFileId: string | null = null;
  try {
    const user = await requireUser();

    // Build a unique title: if base title is taken, append (2), (3), …
    const existingTitles = await prisma.resume.findMany({
      where: { profile: { userId: user.id } },
      select: { title: true },
    });
    const taken = new Set(existingTitles.map((r) => r.title.toLowerCase()));
    const base = title.trim();
    let uniqueTitle = base;
    let counter = 2;
    while (taken.has(uniqueTitle.toLowerCase())) {
      uniqueTitle = `${base} (${counter++})`;
    }

    // Count before creating so we can auto-default the user's first resume.
    const resumeCount = await prisma.resume.count({
      where: { profile: { userId: user.id } },
    });

    const profile = await prisma.profile.findFirst({
      where: {
        userId: user.id,
      },
    });

    createdFileId = upload
      ? await createFileEntry(upload.fileName, upload.filePath)
      : null;

    let res: any;
    let createdResumeId: string;
    if (profile && profile.id) {
      res = await prisma.resume.create({
        data: {
          profileId: profile!.id,
          title: uniqueTitle,
          FileId: createdFileId,
        },
      });
      createdResumeId = res.id;
    } else {
      // No profile yet: profile.create returns the profile, so pull the
      // created resume's id from the nested include.
      res = await prisma.profile.create({
        data: {
          userId: user.id,
          resumes: {
            create: [
              {
                title: uniqueTitle,
                FileId: createdFileId,
              },
            ],
          },
        },
        include: { resumes: { select: { id: true } } },
      });
      createdResumeId = res.resumes[0].id;
    }

    // Auto-default only the user's very first resume (decision #4/#5).
    if (resumeCount === 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: { defaultResumeId: createdResumeId },
      });
    }
    // revalidatePath("/dashboard/myjobs", "page");
    return { success: true, data: res };
  } catch (error) {
    // A File row made for a resume that was never created points at nothing.
    if (createdFileId) {
      await prisma.file
        .deleteMany({ where: { id: createdFileId, Resume: { is: null } } })
        .catch(() => undefined);
    }
    return failure(error, "Failed to create resume.");
  }
};

// Edits a resume of the signed-in user. `fileId`, when given, must already be
// this resume's own file (D-024 i). With an `upload`, the new File row and the
// resume link are written in one transaction, and the old file (`fileId`) is
// removed only AFTER that succeeded, so a failed edit loses nothing.
export const editResumeWith = async (
  id: string,
  title: string,
  fileId?: string,
  upload?: StoredUpload,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    let old: { id: string; filePath: string } | null = null;
    if (fileId) {
      // The download route, the AI import, deleteFile and the backup export
      // all trust the Resume -> File link, so a caller must not be able to
      // link its resume to another user's File by id.
      old = await prisma.file.findFirst({
        where: { id: fileId, Resume: { id, profile: { userId: user.id } } },
        select: { id: true, filePath: true },
      });
      if (!old) throw new FileAccessError();
    }

    const res = await prisma.$transaction(async (tx) => {
      const newFileId = upload
        ? (
            await tx.file.create({
              data: {
                fileName: upload.fileName,
                filePath: upload.filePath,
                fileType: "resume",
              },
            })
          ).id
        : null;
      return tx.resume.update({
        where: { id, profile: { userId: user.id } },
        data: {
          title,
          FileId: newFileId ?? fileId ?? null,
        },
      });
    });

    if (upload && old) {
      const outcome = await removeStoredFile(user.id, old.filePath, false).catch(
        () => "kept" as const,
      );
      if (outcome === "kept") {
        log.warn("[Resume] Replaced file outside the resumes dir kept", {
          code: FILE_OUTSIDE_UPLOADS,
        });
      }
      await prisma.file.delete({ where: { id: old.id } }).catch(() => undefined);
    }
    return { success: true, data: res };
  } catch (error) {
    return failure(error, "Failed to update resume or file.");
  }
};
