"use server";
import prisma from "@/lib/db";
import fs from "fs";
import { rm, writeFile } from "fs/promises";
import { log } from "@/lib/telemetry";
import { resolveInsideDir, resumesDir } from "@/lib/uploadedFile";
import { requireUser } from "./shared";

export const uploadFile = async (file: File, dir: string, path: string) => {
  const bytes = await file.arrayBuffer();
  const buffer = new Uint8Array(bytes);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await writeFile(path, buffer);
};

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
  const real = await resolveInsideDir(resumesDir(), file.filePath);
  if (real) {
    await rm(real, { force: true });
  } else if (fs.existsSync(file.filePath)) {
    log.warn("[Resume] Stored file outside the resumes dir kept; row deleted", {
      code: "FILE_OUTSIDE_UPLOADS",
    });
  }

  await prisma.file.delete({ where: { id: fileId } });
};
