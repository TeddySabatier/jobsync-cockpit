// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { PrismaClient } from "@prisma/client";
import { createJobFor, seedUserWithRefs } from "./helpers/seedUser";

// D-041: the contactSource migration on top of a populated database made by the
// migrations before it. Real SQLite, synthetic data only. It must be pure
// additive DDL: one nullable column, no existing row touched.

const NEW = "20261116120000_contact_source";

describe(`migration ${NEW}: upgrade keeps existing rows`, () => {
  it("adds one nullable column; every existing package survives with contactSource null", async () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, "../../prisma/migrations", NEW, "migration.sql"),
      "utf8",
    );
    const statements = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toEqual(['ALTER TABLE "ApplicationPackage" ADD COLUMN "contactSource" TEXT']);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobsync-mig-cs-"));
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
      const cols = await client.$queryRawUnsafe<{ name: string }[]>(
        `SELECT name FROM pragma_table_info('ApplicationPackage') WHERE name = 'contactSource'`,
      );
      expect(cols).toHaveLength(0);

      const u = await seedUserWithRefs(client, "migcs@example.com");
      const st = await client.jobStatus.create({ data: { label: "Draft", value: "draft" } });
      const jobId = await createJobFor(client, u, st.id);
      await client.$executeRawUnsafe(
        `INSERT INTO "ApplicationPackage" ("id","userId","jobId","version","status","emailTo","emailSubject","emailBody","cvPdfStale","sendStartedAt","sendOutcome","createdAt","updatedAt") VALUES ('p1','${u.id}','${jobId}',1,'approved','hr@acme.example','s','b',0,CURRENT_TIMESTAMP,'unknown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      );
      await client.$disconnect();

      for (const name of fs.readdirSync(path.join(src, "migrations"))) {
        if (name < NEW || !fs.statSync(path.join(src, "migrations", name)).isDirectory()) continue;
        fs.cpSync(path.join(src, "migrations", name), path.join(prismaDir, "migrations", name), {
          recursive: true,
        });
      }
      deploy();

      client = new PrismaClient({ datasources: { db: { url } } });
      const row = await client.applicationPackage.findUniqueOrThrow({ where: { id: "p1" } });
      expect(row).toMatchObject({
        status: "approved",
        sendOutcome: "unknown",
        emailTo: "hr@acme.example",
        contactSource: null,
      });
      await client.applicationPackage.update({
        where: { id: "p1" },
        data: { contactSource: "https://acme.example/careers" },
      });
      expect(
        (await client.applicationPackage.findUniqueOrThrow({ where: { id: "p1" } })).contactSource,
      ).toBe("https://acme.example/careers");
    } finally {
      await client?.$disconnect();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
