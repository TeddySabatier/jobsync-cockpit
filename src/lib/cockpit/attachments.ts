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

export const COCKPIT_QUOTA_MAX_FILES = 200;
export const COCKPIT_QUOTA_MAX_BYTES = 500 * 1024 * 1024;

// Shown to the user; never used as a path.
export function sanitizePdfName(fileName: string): string {
  const base = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return `${base || "attachment"}.pdf`;
}

// One readdir + stat per call, at most COCKPIT_QUOTA_MAX_FILES entries.
// shortcut: two concurrent uploads can both pass the check; fine for one user.
async function assertQuota(dir: string, incomingBytes: number): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (names.length >= COCKPIT_QUOTA_MAX_FILES) throw new CockpitError("TOO_LARGE");
  let total = incomingBytes;
  for (const name of names) {
    total += (await fs.stat(path.join(dir, name))).size;
  }
  if (total > COCKPIT_QUOTA_MAX_BYTES) throw new CockpitError("TOO_LARGE");
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
  await assertQuota(dir, content.length);

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
