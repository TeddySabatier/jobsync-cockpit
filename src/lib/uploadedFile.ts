import fs from "fs/promises";
import path from "path";
import { APP_CONSTANTS } from "@/lib/constants";
import { isCockpitEnabled } from "@/lib/cockpit/config";
import { resolveCockpitFile } from "@/lib/cockpit/files";
import db from "@/lib/db";

// Downloads of stored files (issue #78, D-024). The caller names a File id;
// the path always comes from the File row, never from the request.

// Where resume uploads live (upload route, backup import). Evaluated at call
// time: UPLOADS_DIR is relative ("data") in dev; tests point it at a temp dir.
export function resumesDir(): string {
  return path.join(APP_CONSTANTS.UPLOADS_DIR, "files", "resumes");
}

// The real absolute path of `filePath` if it is a regular file inside both
// the uploads dir and `baseDir`, else null. realpath follows symlinks and
// removes "..", so a link or a stored path that leaves the dir is rejected;
// `+ path.sep` so /uploads never matches /uploads-evil. A missing file, a
// directory or an invalid path (NUL byte) is null as well.
export async function resolveInsideDir(
  baseDir: string,
  filePath: string,
): Promise<string | null> {
  try {
    const root = await fs.realpath(path.resolve(APP_CONSTANTS.UPLOADS_DIR));
    const base = await fs.realpath(path.resolve(baseDir));
    const resolved = await fs.realpath(path.resolve(filePath));
    if (!resolved.startsWith(root + path.sep)) return null;
    if (!resolved.startsWith(base + path.sep)) return null;
    return (await fs.stat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

export type DownloadableFile = { realPath: string; fileName: string };

// Longer than any id the app makes (uuid / cuid); anything longer is not ours.
const MAX_ID_LENGTH = 64;

// The file `fileId` names, if the signed-in user may download it: the file of
// one of the user's resumes (served from the resumes dir), or the CV of one of
// the user's cockpit packages (served from the user's cockpit dir, only while
// the cockpit is enabled). Null for everything else, without saying why.
export async function findDownloadableFile(
  userId: string,
  fileId: string | null | undefined,
): Promise<DownloadableFile | null> {
  if (!userId || !fileId || fileId.length > MAX_ID_LENGTH) return null;

  const row = await db.file.findFirst({
    where: {
      id: fileId,
      OR: [
        { Resume: { profile: { userId } } },
        { applicationPackages: { some: { userId } } },
      ],
    },
    select: {
      fileName: true,
      filePath: true,
      Resume: { select: { profile: { select: { userId: true } } } },
    },
  });
  if (!row) return null;

  let realPath: string | null = null;
  if (row.Resume?.profile?.userId === userId) {
    realPath = await resolveInsideDir(resumesDir(), row.filePath);
  } else if (isCockpitEnabled()) {
    const real = await resolveCockpitFile(userId, row);
    // resolveCockpitFile checks the dir; a download also needs a regular file.
    realPath = real ? await resolveInsideDir(path.dirname(real), real) : null;
  }
  return realPath ? { realPath, fileName: row.fileName } : null;
}
