import fs from "fs/promises";
import path from "path";
import { APP_CONSTANTS } from "@/lib/constants";

// Per-user cockpit upload directory (SPEC §3, §4). A function, evaluated at
// call time: UPLOADS_DIR is relative ("data") in dev and resolves against
// process.cwd(); tests point it at a temp dir.
export function cockpitUserDir(userId: string): string {
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
  // A userId that is not a single path segment could address another dir.
  if (!userId || path.basename(userId) !== userId) return null;
  try {
    const base = await fs.realpath(path.resolve(cockpitUserDir(userId)));
    const resolved = await fs.realpath(path.resolve(file.filePath));
    // `+ path.sep` so cockpit/u1 never matches cockpit/u10.
    return resolved.startsWith(base + path.sep) ? resolved : null;
  } catch {
    return null;
  }
}
