// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { PrismaClient } from "@prisma/client";
import { createJobFor, seedUserWithRefs } from "./helpers/seedUser";

// D-031: the follow-ups migration, applied on top of a populated database made
// by the migrations before it. Real SQLite, synthetic data only.

const NEW = "20261114120000_follow_ups_foundation";

describe(`migration ${NEW}: upgrade keeps existing rows`, () => {
  it("is purely additive: rows survive as applications, versions are per kind, the D-026 restriction holds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobsync-mig-fu-"));
    const src = path.resolve(__dirname, "../../prisma");
    const prismaDir = path.join(root, "prisma");
    fs.cpSync(src, prismaDir, {
      recursive: true,
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

      const u = await seedUserWithRefs(client, "migfu@example.com");
      const st = await client.jobStatus.create({
        data: { label: "Applied", value: "applied" },
      });
      const jobId = await createJobFor(client, u, st.id);
      for (const [id, version, status] of [
        ["p1", 1, "superseded"],
        ["p2", 2, "sent"],
      ] as const) {
        await client.$executeRawUnsafe(
          `INSERT INTO "ApplicationPackage" ("id","userId","jobId","version","status","emailTo","emailSubject","emailBody","cvPdfStale","sentAt","createdAt","updatedAt") VALUES ('${id}','${u.id}','${jobId}',${version},'${status}','a@x.com','s','b',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        );
      }
      await client.$executeRawUnsafe(
        `INSERT INTO "SentEmail" ("id","userId","packageId","fromAddress","toAddress","gmailMessageId","threadId","sentAt") VALUES ('s1','${u.id}','p2','a@x.com','b@x.com','m','t',CURRENT_TIMESTAMP)`,
      );
      await client.$disconnect();

      // This migration and every later one: the generated client expects the latest schema.
      for (const name of fs.readdirSync(path.join(src, "migrations"))) {
        if (name < NEW || name === "migration_lock.toml") continue;
        fs.cpSync(path.join(src, "migrations", name), path.join(prismaDir, "migrations", name), {
          recursive: true,
        });
      }
      deploy();

      client = new PrismaClient({ datasources: { db: { url } } });
      // Existing rows are kept and are applications.
      const pkgs = await client.applicationPackage.findMany({ orderBy: { version: "asc" } });
      expect(pkgs.map((p) => [p.id, p.version, p.kind, p.replyToPackageId, p.status])).toEqual([
        ["p1", 1, "application", null, "superseded"],
        ["p2", 2, "application", null, "sent"],
      ]);
      expect((await client.sentEmail.findUniqueOrThrow({ where: { id: "s1" } })).messageIdHeader).toBeNull();
      expect(await client.jobFollowUp.count()).toBe(0);

      // Versions are per (job, kind): a follow-up may be v1 on the same job, a
      // second application v2 is still refused.
      await client.applicationPackage.create({
        data: {
          userId: u.id,
          jobId,
          version: 1,
          kind: "follow_up",
          replyToPackageId: "p2",
          emailSubject: "Re: s",
          emailBody: "b",
        },
      });
      await expect(
        client.applicationPackage.create({
          data: { userId: u.id, jobId, version: 1, kind: "follow_up", emailSubject: "x", emailBody: "b" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        client.applicationPackage.create({
          data: { userId: u.id, jobId, version: 2, emailSubject: "x", emailBody: "b" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });

      // The old (jobId, version) index is gone, the new one and the idempotency
      // one are there.
      const idx = await client.$queryRawUnsafe<{ name: string }[]>(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ApplicationPackage' AND name NOT LIKE 'sqlite_%'`,
      );
      expect(idx.map((i) => i.name).sort()).toEqual([
        "ApplicationPackage_jobId_kind_version_key",
        "ApplicationPackage_userId_idempotencyKey_key",
        "ApplicationPackage_userId_status_createdAt_idx",
      ]);

      // The D-026 restriction survived (no table was redefined).
      const pkgFks = await client.$queryRawUnsafe<{ table: string; on_delete: string }[]>(
        `SELECT "table", "on_delete" FROM pragma_foreign_key_list('ApplicationPackage')`,
      );
      expect(Object.fromEntries(pkgFks.map((f) => [f.table, f.on_delete]))).toEqual({
        User: "CASCADE",
        Job: "RESTRICT",
        File: "SET NULL",
      });
      await expect(client.job.delete({ where: { id: jobId } })).rejects.toMatchObject({
        code: "P2003",
      });

      // JobFollowUp: one row per job, foreign keys enforced, goes with its job.
      await client.jobFollowUp.create({ data: { userId: u.id, jobId, stopped: true } });
      await expect(
        client.jobFollowUp.create({ data: { userId: u.id, jobId } }),
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        client.jobFollowUp.create({ data: { userId: u.id, jobId: "missing" } }),
      ).rejects.toMatchObject({ code: "P2003" });
      const fks = await client.$queryRawUnsafe<{ table: string; on_delete: string }[]>(
        `SELECT "table", "on_delete" FROM pragma_foreign_key_list('JobFollowUp')`,
      );
      expect(Object.fromEntries(fks.map((f) => [f.table, f.on_delete]))).toEqual({
        User: "CASCADE",
        Job: "CASCADE",
      });
      expect(
        await client.jobFollowUp.findUniqueOrThrow({ where: { jobId } }),
      ).toMatchObject({ outcome: null, stopped: true, skippedThrough: 0, snoozedUntil: null });
    } finally {
      await client?.$disconnect();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
