// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { PrismaClient } from "@prisma/client";
import { createJobFor, seedUserWithRefs } from "./helpers/seedUser";

// Issue #77 / D-028: the SendAttempt migration, applied on top of a populated
// database made by the migrations before it. Real SQLite, synthetic data only.

const NEW = "20261113120000_send_attempt_history";

describe(`migration ${NEW}: upgrade keeps existing rows`, () => {
  it("is purely additive: every existing row survives, history starts empty and works", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobsync-mig77-"));
    const src = path.resolve(__dirname, "../../prisma");
    const prismaDir = path.join(root, "prisma");
    fs.cpSync(src, prismaDir, {
      recursive: true,
      // Later migrations (if any) are not part of the "before" database.
      filter: (p) => {
        const m = /migrations[\\/]([^\\/]+)/.exec(p);
        return !m || m[1] === "migration_lock.toml" || m[1] < NEW;
      },
    });
    const url = `file:${path.join(root, "t.db")}`;
    const schema = path.join(prismaDir, "schema.prisma");
    const env = { ...process.env, DATABASE_URL: url };
    const deploy = () =>
      execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", schema], {
        env,
        stdio: "pipe",
      });
    let client: PrismaClient | undefined;
    try {
      deploy();
      client = new PrismaClient({ datasources: { db: { url } } });
      const before = await client.$queryRawUnsafe<{ name: string }[]>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'SendAttempt'`,
      );
      expect(before).toHaveLength(0);

      const u = await seedUserWithRefs(client, "mig77@example.com");
      const st = await client.jobStatus.create({
        data: { label: "Draft", value: "draft" },
      });
      const jobId = await createJobFor(client, u, st.id);
      await client.$executeRawUnsafe(
        `INSERT INTO "ApplicationPackage" ("id","userId","jobId","version","status","emailSubject","emailBody","cvPdfStale","sendStartedAt","sendOutcome","createdAt","updatedAt") VALUES ('p1','${u.id}','${jobId}',1,'approved','s','b',0,CURRENT_TIMESTAMP,'unknown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      );
      await client.$executeRawUnsafe(
        `INSERT INTO "ApplicationPackage" ("id","userId","jobId","version","status","emailSubject","emailBody","cvPdfStale","createdAt","updatedAt") VALUES ('p2','${u.id}','${jobId}',2,'sent','s','b',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      );
      await client.$executeRawUnsafe(
        `INSERT INTO "SentEmail" ("id","userId","packageId","fromAddress","toAddress","gmailMessageId","threadId","sentAt") VALUES ('s1','${u.id}','p2','a@x.com','b@x.com','m','t',CURRENT_TIMESTAMP)`,
      );
      await client.$disconnect();

      fs.cpSync(
        path.join(src, "migrations", NEW),
        path.join(prismaDir, "migrations", NEW),
        { recursive: true },
      );
      deploy();

      client = new PrismaClient({ datasources: { db: { url } } });
      // Rows kept, with their lock state.
      expect(await client.applicationPackage.count()).toBe(2);
      expect(await client.sentEmail.count()).toBe(1);
      expect(
        await client.applicationPackage.findUniqueOrThrow({ where: { id: "p1" } }),
      ).toMatchObject({ status: "approved", sendOutcome: "unknown" });
      expect(await client.job.count({ where: { id: jobId } })).toBe(1);
      // The history exists and starts empty.
      expect(await client.sendAttempt.count()).toBe(0);

      // It works, and both foreign keys are enforced.
      await client.sendAttempt.create({
        data: { userId: u.id, packageId: "p1", outcome: "ambiguous", errorCode: "GMAIL_TIMEOUT" },
      });
      await expect(
        client.sendAttempt.create({
          data: { userId: u.id, packageId: "missing", outcome: "sent" },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
      // The D-026 restriction is still in place on the redefined table.
      await expect(client.job.delete({ where: { id: jobId } })).rejects.toMatchObject({
        code: "P2003",
      });
      // The history lives and dies with its package only.
      await client.applicationPackage.delete({ where: { id: "p1" } });
      expect(await client.sendAttempt.count()).toBe(0);
      expect(await client.applicationPackage.count()).toBe(1);

      const fks = await client.$queryRawUnsafe<{ table: string; on_delete: string }[]>(
        `SELECT "table", "on_delete" FROM pragma_foreign_key_list('SendAttempt')`,
      );
      expect(Object.fromEntries(fks.map((f) => [f.table, f.on_delete]))).toEqual({
        User: "CASCADE",
        ApplicationPackage: "CASCADE",
      });
    } finally {
      await client?.$disconnect();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
