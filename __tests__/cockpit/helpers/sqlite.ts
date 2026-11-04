import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { PrismaClient } from "@prisma/client";

export type CockpitTestDb = {
  prisma: PrismaClient;
  url: string;
  cleanup: () => Promise<void>;
};

// Temp SQLite file migrated with `prisma migrate deploy` (the real migration
// history, unlike backupTestDb's `db push`). DATABASE_URL points at the temp
// file BEFORE the PrismaClient is created, so code under test that builds its
// own client from the env (e.g. a vi.mock("@/lib/db") factory) hits the temp
// DB, never a real one. Call from beforeAll; call cleanup from afterAll.
export function createCockpitTestDb(): CockpitTestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobsync-cockpit-"));
  const url = `file:${path.join(dir, "test.db")}`;
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;

  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });
  } catch (e) {
    restoreUrl(previousUrl);
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  return {
    prisma,
    url,
    cleanup: async () => {
      await prisma.$disconnect();
      restoreUrl(previousUrl);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function restoreUrl(previous: string | undefined): void {
  if (previous === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previous;
}
