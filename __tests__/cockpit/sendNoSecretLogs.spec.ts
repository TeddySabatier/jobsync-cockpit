// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";

const db = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("./helpers/sqlite");
  return createCockpitTestDb();
});
const uploads = vi.hoisted(() => ({ dir: "" }));
const session = vi.hoisted(() => ({ userId: "" }));
const client = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/db", () => ({ default: db.prisma }));
vi.mock("@/lib/constants", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/constants")>();
  return {
    ...mod,
    APP_CONSTANTS: {
      ...mod.APP_CONSTANTS,
      get UPLOADS_DIR() {
        return uploads.dir;
      },
    },
  };
});
vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(async () => ({ id: session.userId })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The action asks for the real client; hand it the mock instead.
vi.mock("@/lib/cockpit/gmail/client", () => ({
  createHttpGmailClient: () => client.current,
}));

import { CockpitError } from "@/lib/cockpit/errors";
import { sendPackage } from "@/actions/cockpitSend.actions";
import {
  ACCESS_TOKEN,
  ADDRESS,
  mockGmail,
  REFRESH_TOKEN,
  seedSend,
} from "./helpers/sendFixtures";

// AC-36 (send part). Every secret-looking value below must never appear in
// console output, in the action result, or in a thrown error.
const SECRETS = [ACCESS_TOKEN, REFRESH_TOKEN, "BODY-SECRET-TEXT", "RAW-SECRET-PAYLOAD"];

let s: Awaited<ReturnType<typeof seedSend>>;
let gmail: ReturnType<typeof mockGmail>;
const spies = ["log", "info", "warn", "error", "debug"].map((m) =>
  vi.spyOn(console, m as "log"),
);
const logged = () => JSON.stringify(spies.flatMap((x) => x.mock.calls));

beforeAll(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  uploads.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-send-logs-"));
  s = await seedSend(db.prisma, uploads.dir);
  session.userId = s.userA.id;
}, 120_000);
afterAll(async () => {
  fs.rmSync(uploads.dir, { recursive: true, force: true });
  await db.cleanup();
});
beforeEach(() => {
  vi.stubEnv("COCKPIT_ENABLED", "true");
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", ADDRESS);
  gmail = mockGmail();
  client.current = gmail;
  spies.forEach((x) => x.mockReset().mockImplementation(() => {}));
});
afterEach(() => vi.unstubAllEnvs());

async function attempt() {
  const pkg = await s.mkApproved();
  const result = await sendPackage(pkg.id, pkg.updatedAt);
  return { pkg, result };
}
function expectClean(result: unknown) {
  const everything = logged() + JSON.stringify(result);
  for (const secret of SECRETS) expect(everything).not.toContain(secret);
}

describe("send: no secrets in logs or results (AC-36)", () => {
  it("success", async () => {
    const { result } = await attempt();
    expect(result.success).toBe(true);
    expectClean(result);
  });

  it("an unexpected token error whose message carries secrets", async () => {
    gmail.getAccessToken.mockRejectedValue(
      new Error(`boom ${REFRESH_TOKEN} ${ACCESS_TOKEN}`),
    );
    const { result } = await attempt();
    expect(result).toMatchObject({ success: false, code: "INTERNAL" });
    expectClean(result);
  });

  it("an unexpected send error whose message carries the raw message and body", async () => {
    gmail.sendRaw.mockRejectedValue(
      new Error(`Gmail said: RAW-SECRET-PAYLOAD BODY-SECRET-TEXT ${ACCESS_TOKEN}`),
    );
    const { result } = await attempt();
    expect(result).toMatchObject({ success: false, code: "SEND_OUTCOME_UNKNOWN" });
    expectClean(result);
  });

  it("a typed definitive error", async () => {
    gmail.sendRaw.mockRejectedValue(
      new CockpitError("GMAIL_SEND", { status: 400, definitive: true }),
    );
    const { result } = await attempt();
    expect(result).toMatchObject({ success: false, code: "GMAIL_SEND" });
    expectClean(result);
  });

  it("a failed recording transaction after a successful send logs ids, not content", async () => {
    const pkg = await s.mkApproved();
    await db.prisma.sentEmail.create({
      data: {
        userId: s.userA.id,
        packageId: pkg.id,
        fromAddress: ADDRESS,
        toAddress: "x@example.com",
        gmailMessageId: "old",
        threadId: "old",
      },
    });
    const result = await sendPackage(pkg.id, pkg.updatedAt);
    expect(result).toMatchObject({ success: false, code: "SEND_OUTCOME_UNKNOWN" });
    expectClean(result);
  });
});
