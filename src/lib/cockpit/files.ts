import fs from "fs/promises";
import path from "path";
import { APP_CONSTANTS } from "@/lib/constants";

// Per-user cockpit upload directory (SPEC §3, §4). A function, evaluated at
// call time: UPLOADS_DIR is relative ("data") in dev and resolves against
// process.cwd(); tests point it at a temp dir.
export function cockpitUserDir(userId: string): string {
  // A userId that is not a single real path segment ("", ".", "..", "a/b")
  // could address the cockpit root, its parent or another dir.
  if (
    !userId ||
    userId === "." ||
    userId === ".." ||
    path.basename(userId) !== userId
  ) {
    throw new Error("Invalid cockpit user id");
  }
  return path.join(APP_CONSTANTS.UPLOADS_DIR, "files", "cockpit", userId);
}

// The single path-confinement helper (SPEC §4). Returns the real absolute path
// of `file` if it lies inside the user's cockpit dir, else null. realpath
// follows symlinks, so a link pointing out of the dir is rejected; it also
// fails for a missing file, which is the intended "not found".
export async function resolveCockpitFile(
  userId: string,
  file: { filePath: string },
): Promise<string | null> {
  try {
    // cockpitUserDir throws on an invalid userId; the catch maps it to null.
    const base = await fs.realpath(path.resolve(cockpitUserDir(userId)));
    const resolved = await fs.realpath(path.resolve(file.filePath));
    // `+ path.sep` so cockpit/u1 never matches cockpit/u10.
    return resolved.startsWith(base + path.sep) ? resolved : null;
  } catch {
    return null;
  }
}
