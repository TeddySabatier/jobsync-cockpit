// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";

const db = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("./helpers/sqlite");
  return createCockpitTestDb();
});
const uploads = vi.hoisted(() => ({ dir: "" }));

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

import { CockpitError } from "@/lib/cockpit/errors";
import {
  markSendUnknownAsSent,
  releaseSendLock,
  sendApplicationPackage,
} from "@/lib/cockpit/send";
import { toSendHistoryView } from "@/lib/cockpit/packageView";
import { ADDRESS, mockGmail, seedSend } from "./helpers/sendFixtures";

// Independent adversarial review of #77 / D-028 (send path). Real SQLite, mock
// Gmail only, synthetic data.
const prisma = db.prisma;
let s: Awaited<ReturnType<typeof seedSend>>;
let gmail: ReturnType<typeof mockGmail>;
const send = (id: string, at: Date) => sendApplicationPackage(s.userA.id, id, at, gmail);
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as CockpitError;
  }
  throw new Error("expected a rejection");
};
const row = (id: string) => prisma.applicationPackage.findUniqueOrThrow({ where: { id } });
const outcomes = async (packageId: string) =>
  (
    await prisma.sendAttempt.findMany({
      where: { packageId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).map((a) => a.outcome);
const failInserts = (name: string) =>
  prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE INSERT ON "SendAttempt" BEGIN SELECT RAISE(ABORT,'nope'); END`,
  );
const dropTrigger = (name: string) => prisma.$executeRawUnsafe(`DROP TRIGGER ${name}`);

beforeAll(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  uploads.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-adv-"));
  s = await seedSend(prisma, uploads.dir);
}, 120_000);
afterAll(async () => {
  fs.rmSync(uploads.dir, { recursive: true, force: true });
  await db.cleanup();
});
beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", ADDRESS);
  gmail = mockGmail();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("adversarial: concurrent double click", () => {
  it("two simultaneous sends with the same updatedAt: one email, one sent row", async () => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { id: "m1", threadId: "t1" };
    });
    const results = await Promise.allSettled([
      send(pkg.id, pkg.updatedAt),
      send(pkg.id, pkg.updatedAt),
    ]);
    expect(gmail.sendRaw).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await outcomes(pkg.id)).toEqual(["sent"]);
    expect(await row(pkg.id)).toMatchObject({ status: "sent" });
  });
});

describe("adversarial: history write failures on every send path (real DB error)", () => {
  it("definitive Gmail failure: lock released, same code", async () => {
    const pkg = await s.mkApproved();
    await failInserts("t_def");
    try {
      gmail.sendRaw.mockRejectedValue(
        new CockpitError("GMAIL_SEND", { status: 400, definitive: true }),
      );
      expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({ code: "GMAIL_SEND" });
      expect(await row(pkg.id)).toMatchObject({
        sendStartedAt: null,
        sendOutcome: null,
        status: "approved",
      });
    } finally {
      await dropTrigger("t_def");
    }
  });

  it("token failure before Gmail: lock released, INTERNAL, nothing sent", async () => {
    const pkg = await s.mkApproved();
    await failInserts("t_tok");
    try {
      gmail.getAccessToken.mockRejectedValue(new Error("boom"));
      expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({ code: "INTERNAL" });
      expect(await row(pkg.id)).toMatchObject({ sendStartedAt: null });
      expect(gmail.sendRaw).not.toHaveBeenCalled();
    } finally {
      await dropTrigger("t_tok");
    }
  });

  it("ambiguous failure: lock held as unknown, SEND_OUTCOME_UNKNOWN", async () => {
    const pkg = await s.mkApproved();
    await failInserts("t_amb");
    try {
      gmail.sendRaw.mockRejectedValue(new CockpitError("GMAIL_TIMEOUT", { definitive: false }));
      expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
        code: "SEND_OUTCOME_UNKNOWN",
      });
      expect(await row(pkg.id)).toMatchObject({ sendOutcome: "unknown" });
    } finally {
      await dropTrigger("t_amb");
    }
  });

  it("success: still sent, SentEmail recorded", async () => {
    const pkg = await s.mkApproved();
    await failInserts("t_ok");
    try {
      const res = await send(pkg.id, pkg.updatedAt);
      expect(res.id).toBe(pkg.id);
      expect(await row(pkg.id)).toMatchObject({ status: "sent" });
      expect(await prisma.sentEmail.count({ where: { packageId: pkg.id } })).toBe(1);
    } finally {
      await dropTrigger("t_ok");
    }
  });

  it("step 6 failure: SEND_OUTCOME_UNKNOWN, lock held", async () => {
    const pkg = await s.mkApproved();
    await prisma.sentEmail.create({
      data: {
        userId: s.userA.id,
        packageId: pkg.id,
        fromAddress: ADDRESS,
        toAddress: "x@example.com",
        gmailMessageId: "o",
        threadId: "o",
      },
    });
    await failInserts("t_s6");
    try {
      expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
        code: "SEND_OUTCOME_UNKNOWN",
      });
      const r = await row(pkg.id);
      expect(r.sendOutcome).toBe("unknown");
      expect(r.sendStartedAt).not.toBeNull();
    } finally {
      await dropTrigger("t_s6");
    }
  });

  it("a synchronous throw from sendAttempt.create is swallowed too", async () => {
    const pkg = await s.mkApproved();
    vi.spyOn(prisma.sendAttempt, "create").mockImplementation((() => {
      throw new Error("sync");
    }) as never);
    expect((await send(pkg.id, pkg.updatedAt)).id).toBe(pkg.id);
  });

  it("ambiguous: a new send is refused while locked (no second email)", async () => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockRejectedValueOnce(new CockpitError("GMAIL_TIMEOUT", { definitive: false }));
    await rejection(send(pkg.id, pkg.updatedAt));
    const fresh = await row(pkg.id);
    expect(await rejection(send(pkg.id, fresh.updatedAt))).toMatchObject({ code: "CONFLICT" });
    expect(gmail.sendRaw).toHaveBeenCalledTimes(1);
  });
});

describe("adversarial: recovery transaction when the history insert fails", () => {
  it("Mark as sent and Release lock are refused and roll back entirely; retry works later", async () => {
    const pkg = await s.mkApproved({ sendStartedAt: new Date(), sendOutcome: "unknown" });
    await failInserts("t_rec");
    try {
      await expect(markSendUnknownAsSent(s.userA.id, pkg.id)).rejects.toBeDefined();
      expect(await row(pkg.id)).toMatchObject({ status: "approved", sendOutcome: "unknown" });
      await expect(releaseSendLock(s.userA.id, pkg.id)).rejects.toBeDefined();
      expect((await row(pkg.id)).sendStartedAt).not.toBeNull();
    } finally {
      await dropTrigger("t_rec");
    }
    await releaseSendLock(s.userA.id, pkg.id);
    expect((await row(pkg.id)).sendStartedAt).toBeNull();
  });
});

describe("adversarial: slow history write at step 5c while the lock goes stale", () => {
  it("lock aged during the write: D-022 lost-lock path, no duplicate send", async () => {
    const pkg = await s.mkApproved();
    const real = prisma.sendAttempt.create.bind(prisma.sendAttempt);
    let first = true;
    vi.spyOn(prisma.sendAttempt, "create").mockImplementation(((args: unknown) =>
      (async () => {
        if (first) {
          first = false;
          await prisma.applicationPackage.update({
            where: { id: pkg.id },
            data: { sendStartedAt: new Date(Date.now() - 61_000) },
          });
        }
        return (real as (a: unknown) => unknown)(args);
      })()) as never);
    const err = await rejection(send(pkg.id, pkg.updatedAt));
    expect(err).toMatchObject({ code: "SEND_OUTCOME_UNKNOWN" });
    expect(gmail.sendRaw).toHaveBeenCalledTimes(1);
    // Same as main: the aged lock stays (stale rule), nothing recorded, one email.
    const r = await row(pkg.id);
    expect(r.status).toBe("approved");
    expect(r.sendStartedAt).not.toBeNull();
    expect(await outcomes(pkg.id)).toEqual(["sent", "lock_lost"]);
  });
});

describe("adversarial: client view of tampered stored codes", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "errorCode %s gives no reason (never a value from Object.prototype)",
    (code) => {
      const [v] = toSendHistoryView([
        { id: "1", outcome: "failed", errorCode: code, gmailMessageId: null, createdAt: new Date() },
      ]);
      expect(v.reason).toBeNull();
    },
  );
});
