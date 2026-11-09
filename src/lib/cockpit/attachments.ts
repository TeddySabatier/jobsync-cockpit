import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import prisma from "@/lib/db";
import { APP_CONSTANTS } from "@/lib/constants";
import { PDF_MAGIC } from "@/lib/ai/import/extract-text";
import { CockpitError } from "./errors";
import { cockpitUserDir } from "./files";

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

function orphanMaxAgeMs(): number {
  const raw = Number(process.env.COCKPIT_ORPHAN_DAYS);
  const days = Number.isFinite(raw) && raw >= 1 ? raw : COCKPIT_ORPHAN_DAYS_DEFAULT;
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
      const st = await fs.stat(full);
      if (st.isFile() && st.mtimeMs < cutoff) old.push(full);
    } catch {
      // vanished meanwhile
    }
  }
  if (old.length === 0) return 0;

  // Rows that something still points to are never touched.
  const inUse = await prisma.file.findMany({
    where: {
      filePath: { in: old },
      OR: [{ applicationPackages: { some: {} } }, { Resume: { isNot: null } }],
    },
    select: { filePath: true },
  });
  const keep = new Set(inUse.map((r) => r.filePath));
  const doomed = old.filter((p) => !keep.has(p));
  if (doomed.length === 0) return 0;

  // Rows first: a row that outlives its bytes is harmless, the reverse is not.
  await prisma.file.deleteMany({ where: { filePath: { in: doomed } } });
  for (const full of doomed) await fs.rm(full, { force: true });
  return doomed.length;
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
