import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import prisma from "@/lib/db";
import { getTimestampedFileName, handleError } from "@/lib/utils";
import { resumesDir } from "@/lib/uploadedFile";
import { createFileEntry, requireUser } from "./shared";

// Not a "use server" module (issue #78, D-024): these functions take a stored
// upload ({ fileName, filePath }), and an exported server action must never
// accept a path from the client. Only the upload route calls them, with a path
// it made itself via storeResumeUpload. The actions in resume.ts wrap them
// without the upload argument.

export type StoredUpload = { fileName: string; filePath: string };

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

export const createResumeProfileWith = async (
  title: string,
  upload?: StoredUpload,
): Promise<any | undefined> => {
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

    const fileId = upload
      ? await createFileEntry(upload.fileName, upload.filePath)
      : null;

    let res: any;
    let createdResumeId: string;
    if (profile && profile.id) {
      res = await prisma.resume.create({
        data: {
          profileId: profile!.id,
          title: uniqueTitle,
          FileId: fileId,
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
                FileId: fileId,
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
    const msg = "Failed to create resume.";
    return handleError(error, msg);
  }
};

export const editResumeWith = async (
  id: string,
  title: string,
  fileId?: string,
  upload?: StoredUpload,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    let resolvedFileId = fileId;

    if (fileId) {
      // A given File id must already be this resume's own file (issue #78,
      // D-024): the download route, the AI import, deleteFile and the backup
      // export all trust the Resume -> File link, so a caller must not be able
      // to link its resume to another user's File by id. One message for a
      // missing id and someone else's.
      const own = await prisma.file.findFirst({
        where: { id: fileId, Resume: { id, profile: { userId: user.id } } },
        select: { id: true },
      });
      if (!own) throw new Error("File not found or access denied");
    } else if (upload) {
      resolvedFileId = await createFileEntry(upload.fileName, upload.filePath);
    }

    const res = await prisma.resume.update({
      where: { id, profile: { userId: user.id } },
      data: {
        title,
        FileId: resolvedFileId || null,
      },
    });
    return { success: true, data: res };
  } catch (error) {
    const msg = "Failed to update resume or file.";
    return handleError(error, msg);
  }
};
