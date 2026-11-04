// @vitest-environment node
import fs from "fs";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { buildBackupZip, collectBackupData } from "@/lib/backup/export";
import { INSERT_ORDER, MODEL_SPECS } from "@/lib/backup/ordering";
import { seedAccount } from "../helpers/backupTestDb";

// AC-39: the backup never carries GmailAccount. The export is driven by the
// explicit INSERT_ORDER / MODEL_SPECS allow-list (not a generic table dump),
// so the cockpit tables are out unless someone adds them there.
const ctx = await vi.hoisted(async () => {
  const helpers = await import("../helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return { default: new PrismaClient({ datasources: { db: { url: ctx.url } } }) };
});
vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const CIPHER = "CIPHERTEXT-MARKER-0001";
const IV = "IVSALT-MARKER-0002.IVBYTES-MARKER-0003";
const SCOPES_MARKER = "scopes-marker-0004";
let userId: string;

beforeAll(async () => {
  userId = await seedAccount(prisma, "owner@example.com");
  await prisma.gmailAccount.create({
    data: {
      userId,
      email: "gmail-marker-0005@example.com",
      encryptedRefreshToken: CIPHER,
      iv: IV,
      scopes: SCOPES_MARKER,
    },
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe("backup exclusion (AC-39)", () => {
  it("the account row exists", async () => {
    expect(await prisma.gmailAccount.count({ where: { userId } })).toBe(1);
  });

  it("GmailAccount is not in the export model list", () => {
    expect(INSERT_ORDER as string[]).not.toContain("GmailAccount");
    expect(Object.values(MODEL_SPECS).map((s) => s.delegate)).not.toContain("gmailAccount");
  });

  it("collectBackupData has no GmailAccount, token, iv or marker values", async () => {
    const data = await collectBackupData(userId);
    const text = JSON.stringify(data);
    const keys = keysDeep(data);
    expect(keys).not.toContain("GmailAccount");
    expect(keys).not.toContain("gmailAccount");
    expect(keys).not.toContain("encryptedRefreshToken");
    expect(keys).not.toContain("iv");
    for (const marker of [CIPHER, "IVSALT-MARKER", "IVBYTES-MARKER", SCOPES_MARKER, "gmail-marker-0005"]) {
      expect(text).not.toContain(marker);
    }
  });

  it("the zip file contains none of it either", async () => {
    const { buffer } = await buildBackupZip(userId, "owner@example.com");
    const zip = await JSZip.loadAsync(buffer);
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir) continue;
      const body = await zip.files[name].async("string");
      expect(body, name).not.toMatch(/GmailAccount|encryptedRefreshToken|CIPHERTEXT-MARKER|IVSALT-MARKER|gmail-marker/);
    }
  });
});
