"use server";
import prisma from "@/lib/db";
import { log } from "@/lib/telemetry";
import { FILE_OUTSIDE_UPLOADS, removeStoredFile } from "@/lib/uploadedFile";
import { requireUser } from "./shared";

// Uploads are written by storeResumeUpload (resumeWrite.ts, not an action):
// no exported action takes a path (issue #78, D-024).

export const deleteFile = async (fileId: string) => {
  const user = await requireUser();

  const file = await prisma.file.findFirst({
    where: {
      id: fileId,
      Resume: { profile: { userId: user.id } },
    },
  });

  if (!file) {
    throw new Error("File not found or access denied");
  }

  // Only a regular file inside the resumes dir after realpath is removed
  // (issue #78, D-024). A stored path outside it (a legacy row, a symlink
  // pointing out) keeps its file: only the row goes. The log carries a code,
  // never the path.
  const outcome = await removeStoredFile(user.id, file.filePath, false);
  if (outcome === "kept") {
    log.warn("[Resume] Stored file outside the resumes dir kept; row deleted", {
      code: FILE_OUTSIDE_UPLOADS,
    });
  }

  await prisma.file.delete({ where: { id: fileId } });
};
