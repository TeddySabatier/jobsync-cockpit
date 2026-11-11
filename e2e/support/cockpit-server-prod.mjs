// Starts the cockpit E2E dev server: fresh synthetic SQLite DB, throwaway
// secrets (in process env only), fake Google preload. Never touches the real
// app port, Docker or real data. Scratch lives in .cockpit-tmp/.
//
//   E2E_PORT          default 3738
//   COCKPIT_ENABLED   default "true" (the flag-off run sets "false")
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const port = process.env.E2E_PORT || "3738";
if (port === "3737") throw new Error("refusing to use port 3737");

const tmp = path.join(root, ".cockpit-tmp");
const dbDir = path.join(tmp, "db");
const logDir = path.join(tmp, "logs");
fs.mkdirSync(dbDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

const dbFile = path.join(dbDir, `e2e-${port}.db`);
for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  fs.rmSync(dbFile + suffix, { force: true });
}
const databaseUrl = `file:${dbFile}`;

// Fresh fake-Google state.
fs.rmSync(path.join(tmp, "fake-google.log"), { force: true });
fs.rmSync(path.join(tmp, "fake-google.mode"), { force: true });

execFileSync("npx", ["prisma", "migrate", "deploy"], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: "pipe",
});

// Seed the way signup() does: user, job sources, job statuses (the send flow
// needs the "applied" status). Synthetic identity only.
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const user = await prisma.user.create({
  data: {
    name: "Jane Doe",
    email: "admin@example.com",
    password: await bcrypt.hash("password123", 10),
  },
});
for (const [label, value] of [
  ["Indeed", "indeed"],
  ["Linkedin", "linkedin"],
  ["Company Career page", "careerpage"],
]) {
  await prisma.jobSource.create({ data: { label, value, createdBy: user.id } });
}
for (const [label, value] of [
  ["New", "new"],
  ["Draft", "draft"],
  ["Applied", "applied"],
  ["Interview", "interview"],
  ["Offer", "offer"],
  ["Offer Accepted", "offer-accepted"],
  ["Offer Declined", "offer-declined"],
  ["Rejected", "rejected"],
  ["Expired", "expired"],
  ["Archived", "archived"],
]) {
  await prisma.jobStatus.upsert({ where: { value }, update: {}, create: { label, value } });
}
// Bot MCP token, seeded directly: clicking "MCP Access" in Settings hangs the
// renderer under headless Chromium + next dev (see PR notes), so the UI flow
// from e2e/mcp-add-job.spec.ts is not usable here. Mirrors createMcpToken().
const mcpToken = "jsync_" + randomBytes(32).toString("base64url");
await prisma.mcpAccessToken.create({
  data: {
    userId: user.id,
    name: "cockpit e2e bot",
    tokenHash: createHash("sha256").update(mcpToken).digest("hex"),
    tokenPrefix: mcpToken.slice(0, 12),
    scopes: JSON.stringify(["jobs:write", "questions:write", "resume:write", "jobs:read", "package:write"]),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  },
});
fs.writeFileSync(path.join(tmp, `e2e-mcp-token-${port}.txt`), mcpToken);
await prisma.$disconnect();
// Only an id: lets the global teardown remove the uploads this run created.
fs.writeFileSync(path.join(tmp, `e2e-user-${port}.json`), JSON.stringify({ id: user.id }));

const origin = `http://localhost:${port}`;
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  AUTH_SECRET: randomBytes(32).toString("base64"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  NEXTAUTH_URL: origin,
  AUTH_URL: origin,
  AUTH_TRUST_HOST: "true",
  COCKPIT_ENABLED: process.env.COCKPIT_ENABLED ?? "true",
  MCP_ENABLED: "true",
  GOOGLE_CLIENT_ID: "fake-client-id",
  GOOGLE_CLIENT_SECRET: "fake-client-secret",
  GOOGLE_REDIRECT_URI: `${origin}/api/cockpit/gmail/callback`,
  COCKPIT_GMAIL_ALLOWED_ADDRESS: "you@example.com",
  COCKPIT_E2E_TMP: tmp,
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_OPTIONS: [
    process.env.NODE_OPTIONS,
    `--require ${path.join(root, "e2e", "support", "fake-google.cjs")}`,
    "--max-old-space-size=2048",
  ]
    .filter(Boolean)
    .join(" "),
};

const out = fs.openSync(path.join(logDir, `e2e-server-${port}.log`), "w");
const next = spawn(
  process.execPath,
  [require.resolve("next/dist/bin/next"), "start", "-p", port],
  { cwd: root, env, stdio: ["ignore", out, out] },
);
const stop = () => next.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
next.on("exit", (code) => process.exit(code ?? 0));
