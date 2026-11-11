import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import prisma from "@/lib/db";
import { APP_CONSTANTS } from "@/lib/constants";
import { PDF_MAGIC } from "@/lib/ai/import/extract-text";
import { log } from "@/lib/telemetry";
import { CockpitError } from "./errors";
import { cockpitUserDir } from "./files";
import { letterPdfName } from "./letterName";

// attach_file storage (cockpit/SPEC.md §3). The stored path is generated here
// (`<cockpitUserDir>/<uuid>.pdf`), never taken from input.

// No count or size quota (D-013). Bloat is limited by removing uploads that
// never became part of a package (see cleanupOrphanUploads).
export const COCKPIT_ORPHAN_DAYS_DEFAULT = 7;

// Shown to the user; never used as a path.
export function sanitizePdfName(fileName: string): string {
  const base = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return `${base || "attachment"}.pdf`;
}

// Display name of the cover-letter PDF. Dialog, preview download and Send all
// use this one function, so the owner sees the name the recipient gets.
// The inner sanitize turns the CV name into plain [A-Za-z0-9._-] so the "CV"
// token is found between underscores; the outer one guards the final name.
export function letterAttachmentName(cvFileName: string | null | undefined): string {
  return sanitizePdfName(letterPdfName(sanitizePdfName(cvFileName ?? "")));
}

let orphanDaysWarned = false;

function orphanMaxAgeMs(): number {
  const set = process.env.COCKPIT_ORPHAN_DAYS;
  const raw = Number(set);
  const valid = Number.isFinite(raw) && raw >= 1;
  if (set && !valid && !orphanDaysWarned) {
    // Not silent (once per process): a value below 1 (or not a number) falls
    // back to the default.
    orphanDaysWarned = true;
    log.warn("cockpit: COCKPIT_ORPHAN_DAYS ignored, using the default", {
      code: "ORPHAN_DAYS_INVALID",
    });
  }
  const days = valid ? raw : COCKPIT_ORPHAN_DAYS_DEFAULT;
  return days * 24 * 60 * 60 * 1000;
}

// Deletes the user's uploaded files that no ApplicationPackage (or Resume)
// references and that are older than COCKPIT_ORPHAN_DAYS (default 7, minimum 1):
// the leftovers of failed or abandoned submits, plus stray files with no row.
// Packages, including superseded and sent ones, keep their CV.
// Returns how many files were removed.
export async function cleanupOrphanUploads(
  userId: string,
  now: number = Date.now(),
): Promise<number> {
  const dir = cockpitUserDir(userId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
  const cutoff = now - orphanMaxAgeMs();
  const old: string[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      // lstat: a symlink is judged (and removed) as the link, never its target.
      const st = await fs.lstat(full);
      if ((st.isFile() || st.isSymbolicLink()) && st.mtimeMs < cutoff) old.push(name);
    } catch {
      // vanished meanwhile
    }
  }
  if (old.length === 0) return 0;

  // Rows are matched by file name (a generated <uuid>.pdf), not by the stored
  // path string: UPLOADS_DIR may be relative or absolute, or differ between
  // runs, and an exact path match would then see every file as stray.
  const rows = await prisma.file.findMany({
    where: { OR: old.map((name) => ({ filePath: { endsWith: name } })) },
    select: {
      id: true,
      filePath: true,
      applicationPackages: { select: { id: true }, take: 1 },
      Resume: { select: { id: true } },
    },
  });
  // endsWith only pre-filters: keep rows whose last segment (either separator,
  // a row may come from a Windows install) is exactly a candidate name. Names
  // are compared lowercased: on a case-insensitive filesystem a row differing
  // only in case is the same file, and this can only keep more files.
  const key = (n: string) => n.toLowerCase();
  const oldNames = new Set(old.map(key));
  const base = (p: string) => p.split(/[\\/]/).pop() ?? "";
  const ours = path.resolve(dir);
  const rowsOf = new Map<string, string[]>();
  const deletable: string[] = [];
  for (const r of rows) {
    const name = key(base(r.filePath));
    if (!oldNames.has(name)) continue;
    rowsOf.set(name, [...(rowsOf.get(key(name)) ?? []), r.id]);
    // Only rows pointing into this user's directory are deleted here; any
    // other row with the same name is left alone and keeps the file. A row
    // that already has a package or resume is claimed outright: no delete is
    // attempted for it (keeps the write transaction small).
    const referenced = r.applicationPackages.length > 0 || r.Resume !== null;
    if (!referenced && path.resolve(path.dirname(r.filePath)) === ours) {
      deletable.push(r.id);
    }
  }

  // One transaction; each delete re-checks "still unreferenced" in its own
  // statement, so a package or resume that claimed the row meanwhile wins
  // (count 0) and its file is kept. Rows first: a row that outlives its bytes
  // is harmless, the reverse is not.
  const unreferenced = {
    applicationPackages: { none: {} },
    Resume: { is: null },
  };
  const counts = deletable.length
    ? await prisma.$transaction(
        deletable.map((id) => prisma.file.deleteMany({ where: { id, ...unreferenced } })),
      )
    : [];
  const deleted = new Set(deletable.filter((_, i) => counts[i].count === 1));

  let removed = 0;
  for (const name of old) {
    const claimed = (rowsOf.get(key(name)) ?? []).some((id) => !deleted.has(id));
    if (claimed) continue;
    await fs.rm(path.join(dir, name), { force: true });
    removed++;
  }
  return removed;
}

export async function attachFile(
  userId: string,
  input: { fileName: string; contentBase64: string },
): Promise<{ fileId: string; fileName: string; sizeBytes: number }> {
  const content = Buffer.from(input.contentBase64, "base64");
  if (content.length > APP_CONSTANTS.MAX_RESUME_FILE_SIZE_BYTES) {
    throw new CockpitError("TOO_LARGE");
  }
  if (!content.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new CockpitError("VALIDATION");
  }

  const dir = cockpitUserDir(userId);
  // Housekeeping must never block an upload.
  await cleanupOrphanUploads(userId).catch(() => 0);

  const fileName = sanitizePdfName(input.fileName);
  const filePath = path.join(dir, `${crypto.randomUUID()}.pdf`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, { flag: "wx" });

  try {
    const row = await prisma.file.create({
      data: { fileName, filePath, fileType: "application/pdf" },
    });
    return { fileId: row.id, fileName, sizeBytes: content.length };
  } catch (e) {
    await fs.rm(filePath, { force: true });
    throw e;
  }
}
