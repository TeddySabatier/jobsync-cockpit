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
import { listSendHistory, updatePackageContent } from "@/lib/cockpit/packages";
import { toSendHistoryView } from "@/lib/cockpit/packageView";
import { ADDRESS, mockGmail, seedSend } from "./helpers/sendFixtures";

// Issue #77 / D-028: the send history. Real migrations on a temp SQLite DB; the
// Gmail client is always a mock, nothing reaches Google. Synthetic data only.
const prisma = db.prisma;
let s: Awaited<ReturnType<typeof seedSend>>;
let gmail: ReturnType<typeof mockGmail>;

const send = (id: string, at: Date) =>
  sendApplicationPackage(s.userA.id, id, at, gmail);
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as CockpitError;
  }
  throw new Error("expected a rejection");
};
const row = (id: string) =>
  prisma.applicationPackage.findUniqueOrThrow({ where: { id } });
const attempts = (packageId: string) =>
  prisma.sendAttempt.findMany({
    where: { packageId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
const outcomes = async (packageId: string) =>
  (await attempts(packageId)).map((a) => a.outcome);
const ago = (ms: number) => new Date(Date.now() - ms);
// The Gmail call outlived the stale-lock window and the owner used a recovery
// action while it was still in flight (D-022).
const staleThen = async (
  id: string,
  action: (userId: string, id: string) => Promise<unknown>,
) => {
  await prisma.applicationPackage.update({
    where: { id },
    data: { sendStartedAt: ago(61_000) },
  });
  await action(s.userA.id, id);
};

beforeAll(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  uploads.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-hist-"));
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

describe("send history: success", () => {
  it("records the Gmail message and thread id of a sent package", async () => {
    const pkg = await s.mkApproved();
    await send(pkg.id, pkg.updatedAt);
    const rows = await attempts(pkg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: s.userA.id,
      outcome: "sent",
      errorCode: null,
      gmailMessageId: "gmail-msg-1",
      threadId: "gmail-thread-1",
    });
  });

  it("the message id is written BEFORE the success transaction starts", async () => {
    const pkg = await s.mkApproved();
    const seen: string[] = [];
    // The first write of the success transaction is the package update.
    const realTx = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, ...rest: unknown[]) => {
      return (async () => {
        seen.push(...(await outcomes(pkg.id)));
        return (realTx as (...a: unknown[]) => unknown)(fn, ...rest);
      })();
    }) as never);
    await send(pkg.id, pkg.updatedAt);
    expect(seen).toEqual(["sent"]);
  });
});

describe("send history: the success transaction fails after Gmail answered", () => {
  it("keeps the message id: sent + record_failed rows, lock held as unknown", async () => {
    const pkg = await s.mkApproved();
    // A SentEmail for this package already exists: the unique key fails step 6.
    await prisma.sentEmail.create({
      data: {
        userId: s.userA.id,
        packageId: pkg.id,
        fromAddress: ADDRESS,
        toAddress: "x@example.com",
        gmailMessageId: "old",
        threadId: "old",
      },
    });
    const err = await rejection(send(pkg.id, pkg.updatedAt));
    expect(err).toMatchObject({ code: "SEND_OUTCOME_UNKNOWN" });
    const rows = await attempts(pkg.id);
    expect(rows.map((r) => r.outcome)).toEqual(["sent", "record_failed"]);
    for (const r of rows) {
      expect(r).toMatchObject({
        gmailMessageId: "gmail-msg-1",
        threadId: "gmail-thread-1",
      });
    }
    expect(await row(pkg.id)).toMatchObject({
      status: "approved",
      sendOutcome: "unknown",
    });
  });

  it("an error inside the transaction (no applied status) keeps the id too", async () => {
    const pkg = await s.mkApproved();
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER block_job_h BEFORE UPDATE ON Job
       WHEN NEW.id = '${pkg.jobId}'
       BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    const err = await rejection(send(pkg.id, pkg.updatedAt));
    await prisma.$executeRawUnsafe("DROP TRIGGER block_job_h");
    expect(err).toMatchObject({ code: "SEND_OUTCOME_UNKNOWN" });
    expect(await outcomes(pkg.id)).toEqual(["sent", "record_failed"]);
    expect((await attempts(pkg.id))[0].gmailMessageId).toBe("gmail-msg-1");
  });
});

describe("send history: ambiguous outcome", () => {
  it.each([
    ["timeout", new CockpitError("GMAIL_TIMEOUT", { definitive: false }), "GMAIL_TIMEOUT"],
    ["5xx", new CockpitError("GMAIL_SEND", { status: 503, definitive: false }), "GMAIL_SEND"],
    ["unexpected error", new Error("socket hang up SECRET-RAW-TEXT"), null],
  ])("%s: one ambiguous row, no message id, lock kept", async (_n, failure, code) => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockRejectedValue(failure);
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
      code: "SEND_OUTCOME_UNKNOWN",
    });
    const rows = await attempts(pkg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "ambiguous",
      errorCode: code,
      gmailMessageId: null,
      threadId: null,
    });
    // Never raw error text.
    expect(JSON.stringify(rows)).not.toContain("SECRET-RAW-TEXT");
    expect(await row(pkg.id)).toMatchObject({ status: "approved", sendOutcome: "unknown" });
  });
});

describe("send history: definitive failure", () => {
  it("a definitive Gmail rejection is recorded with its code and the lock is released", async () => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockRejectedValue(
      new CockpitError("GMAIL_SEND", { status: 400, definitive: true }),
    );
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({ code: "GMAIL_SEND" });
    const rows = await attempts(pkg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "failed",
      errorCode: "GMAIL_SEND",
      gmailMessageId: null,
    });
    expect(await row(pkg.id)).toMatchObject({ sendStartedAt: null, sendOutcome: null });
  });

  it("a failure before the Gmail call (token) is recorded too", async () => {
    const pkg = await s.mkApproved();
    gmail.getAccessToken.mockRejectedValue(
      new CockpitError("GMAIL_TOKEN", { status: 500, definitive: true }),
    );
    await rejection(send(pkg.id, pkg.updatedAt));
    expect(gmail.sendRaw).not.toHaveBeenCalled();
    const rows = await attempts(pkg.id);
    expect(rows.map((r) => [r.outcome, r.errorCode])).toEqual([["failed", "GMAIL_TOKEN"]]);
  });

  it("an unexpected error before the Gmail call is recorded as INTERNAL, without its text", async () => {
    const pkg = await s.mkApproved();
    gmail.getAccessToken.mockRejectedValue(new Error("db password=hunter2"));
    await rejection(send(pkg.id, pkg.updatedAt));
    const rows = await attempts(pkg.id);
    expect(rows.map((r) => [r.outcome, r.errorCode])).toEqual([["failed", "INTERNAL"]]);
    expect(JSON.stringify(rows)).not.toContain("hunter2");
  });

  it("a refused send (CONFLICT before the lock) records nothing: nothing was attempted", async () => {
    const pkg = await s.mkApproved();
    const stale = new Date(pkg.updatedAt.getTime() - 5_000);
    await rejection(send(pkg.id, stale));
    expect(await attempts(pkg.id)).toHaveLength(0);
  });
});

describe("send history: several attempts on one package", () => {
  it("a failed attempt then a successful one: both stay, in order", async () => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockRejectedValueOnce(
      new CockpitError("GMAIL_SEND", { status: 400, definitive: true }),
    );
    await rejection(send(pkg.id, pkg.updatedAt));
    const again = await row(pkg.id);
    await send(pkg.id, again.updatedAt);
    const rows = await attempts(pkg.id);
    expect(rows.map((r) => r.outcome)).toEqual(["failed", "sent"]);
    expect(rows[0].gmailMessageId).toBeNull();
    expect(rows[1].gmailMessageId).toBe("gmail-msg-1");
    expect(rows[0].createdAt.getTime()).toBeLessThanOrEqual(rows[1].createdAt.getTime());
  });

  it("ambiguous, Release lock, then a second send: all rows kept, ids not mixed up", async () => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockRejectedValueOnce(new CockpitError("GMAIL_TIMEOUT", { definitive: false }));
    await rejection(send(pkg.id, pkg.updatedAt));
    await releaseSendLock(s.userA.id, pkg.id);
    gmail.sendRaw.mockResolvedValueOnce({ id: "second-msg", threadId: "second-thread" });
    await send(pkg.id, (await row(pkg.id)).updatedAt);
    const rows = await attempts(pkg.id);
    expect(rows.map((r) => r.outcome)).toEqual(["ambiguous", "lock_released", "sent"]);
    expect(rows.map((r) => r.gmailMessageId)).toEqual([null, null, "second-msg"]);
  });
});

describe("send history: lost-lock paths (D-022 h)", () => {
  it("lock released and package rejected before Gmail answered: late_recorded with the id", async () => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockImplementationOnce(async () => {
      await staleThen(pkg.id, releaseSendLock);
      await prisma.applicationPackage.update({
        where: { id: pkg.id },
        data: { status: "rejected" },
      });
      return { id: "late-msg", threadId: "late-thread" };
    });
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
      code: "SEND_OUTCOME_UNKNOWN",
    });
    expect(await prisma.sentEmail.count({ where: { packageId: pkg.id } })).toBe(1);
    const rows = await attempts(pkg.id);
    expect(rows.map((r) => r.outcome)).toEqual(["lock_released", "sent", "late_recorded"]);
    expect(rows[1].gmailMessageId).toBe("late-msg");
    expect(rows[2].gmailMessageId).toBe("late-msg");
  });

  it("lock released while the package is still approved: sent + lock_lost, held as unknown", async () => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockImplementationOnce(async () => {
      await staleThen(pkg.id, releaseSendLock);
      return { id: "late-msg", threadId: "late-thread" };
    });
    await rejection(send(pkg.id, pkg.updatedAt));
    expect(await outcomes(pkg.id)).toEqual(["lock_released", "sent", "lock_lost"]);
    expect(await row(pkg.id)).toMatchObject({ status: "approved", sendOutcome: "unknown" });
  });

  it("Mark as sent ran while Gmail answered: the late id is still kept", async () => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockImplementationOnce(async () => {
      await staleThen(pkg.id, markSendUnknownAsSent);
      return { id: "late-msg", threadId: "late-thread" };
    });
    await rejection(send(pkg.id, pkg.updatedAt));
    expect(await outcomes(pkg.id)).toEqual(["marked_sent", "sent", "lock_lost"]);
    expect((await attempts(pkg.id))[1].gmailMessageId).toBe("late-msg");
    expect(await row(pkg.id)).toMatchObject({ status: "sent", sentVia: "manual" });
  });

  it("ambiguous failure after Release lock: ambiguous row appended", async () => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockImplementationOnce(async () => {
      await staleThen(pkg.id, releaseSendLock);
      throw new CockpitError("GMAIL_TIMEOUT", { definitive: false });
    });
    await rejection(send(pkg.id, pkg.updatedAt));
    expect(await outcomes(pkg.id)).toEqual(["lock_released", "ambiguous"]);
  });
});

describe("send history: recovery decisions are part of the history", () => {
  it("Mark as sent and Release lock each append one row", async () => {
    const a = await s.mkApproved();
    gmail.sendRaw.mockRejectedValueOnce(new CockpitError("GMAIL_TIMEOUT", { definitive: false }));
    await rejection(send(a.id, a.updatedAt));
    await markSendUnknownAsSent(s.userA.id, a.id);
    expect(await outcomes(a.id)).toEqual(["ambiguous", "marked_sent"]);

    const b = await s.mkApproved();
    gmail.sendRaw.mockRejectedValueOnce(new CockpitError("GMAIL_TIMEOUT", { definitive: false }));
    await rejection(send(b.id, b.updatedAt));
    await releaseSendLock(s.userA.id, b.id);
    expect(await outcomes(b.id)).toEqual(["ambiguous", "lock_released"]);
  });

  it("a refused recovery (not recoverable) appends nothing", async () => {
    const pkg = await s.mkApproved();
    await expect(releaseSendLock(s.userA.id, pkg.id)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expect(markSendUnknownAsSent(s.userA.id, pkg.id)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect(await attempts(pkg.id)).toHaveLength(0);
  });
});

describe("send history: a failing history write never changes the send result", () => {
  it("success still succeeds, the id is logged", async () => {
    const pkg = await s.mkApproved();
    const err = vi.spyOn(console, "error");
    vi.spyOn(prisma.sendAttempt, "create").mockRejectedValue(new Error("disk full"));
    const res = await send(pkg.id, pkg.updatedAt);
    expect(res.id).toBe(pkg.id);
    expect(await row(pkg.id)).toMatchObject({ status: "sent" });
    expect(await prisma.sentEmail.count({ where: { packageId: pkg.id } })).toBe(1);
    expect(JSON.stringify(err.mock.calls)).toContain("gmail-msg-1");
  });

  it("an ambiguous failure still holds the lock and returns SEND_OUTCOME_UNKNOWN", async () => {
    const pkg = await s.mkApproved();
    vi.spyOn(prisma.sendAttempt, "create").mockRejectedValue(new Error("disk full"));
    gmail.sendRaw.mockRejectedValue(new CockpitError("GMAIL_TIMEOUT", { definitive: false }));
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
      code: "SEND_OUTCOME_UNKNOWN",
    });
    expect(await row(pkg.id)).toMatchObject({ sendOutcome: "unknown" });
  });
});

describe("send history: append only", () => {
  it("package edits and status changes never touch the history", async () => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockRejectedValueOnce(
      new CockpitError("GMAIL_SEND", { status: 400, definitive: true }),
    );
    await rejection(send(pkg.id, pkg.updatedAt));
    const before = await attempts(pkg.id);
    await prisma.applicationPackage.update({
      where: { id: pkg.id },
      data: { status: "pending", approvedAt: null },
    });
    const cur = await row(pkg.id);
    await updatePackageContent(s.userA.id, pkg.id, {
      emailSubject: "Edited subject",
    });
    expect(await attempts(pkg.id)).toEqual(before);
  });

  it("the history survives the deletion of its job being refused (D-026)", async () => {
    const pkg = await s.mkApproved();
    await send(pkg.id, pkg.updatedAt);
    await expect(prisma.job.delete({ where: { id: pkg.jobId } })).rejects.toMatchObject({
      code: "P2003",
    });
    expect(await attempts(pkg.id)).toHaveLength(1);
  });

  it("goes away only with its package", async () => {
    const pkg = await s.mkApproved();
    await send(pkg.id, pkg.updatedAt);
    await prisma.applicationPackage.delete({ where: { id: pkg.id } });
    expect(await attempts(pkg.id)).toHaveLength(0);
  });

  it("no source file other than send.ts creates, updates or deletes attempts", () => {
    const root = path.resolve(__dirname, "../../src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          const text = fs.readFileSync(p, "utf8");
          if (/sendAttempt\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/.test(text)) {
            hits.push(path.relative(root, p));
          }
        }
      }
    };
    walk(root);
    // The backup restore wipes and re-inserts through MODEL_SPECS (generic
    // delegates), not through this name.
    expect(hits).toEqual([]);
  });
});

describe("send history: read side", () => {
  it("lists only the caller's attempts, oldest first, with the fixed message of the code", async () => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockRejectedValueOnce(
      new CockpitError("GMAIL_SEND", { status: 400, definitive: true }),
    );
    await rejection(send(pkg.id, pkg.updatedAt));
    await send(pkg.id, (await row(pkg.id)).updatedAt);

    const mine = await listSendHistory(s.userA.id, pkg.id);
    expect(mine.map((r) => r.outcome)).toEqual(["failed", "sent"]);
    expect(await listSendHistory(s.userNoGmail.id, pkg.id)).toEqual([]);

    const view = toSendHistoryView(mine);
    expect(view[0].reason).toBe("Gmail rejected the message");
    expect(view[1].reason).toBeNull();
    expect(view[1].gmailMessageId).toBe("gmail-msg-1");
    // Only the listed fields reach the client.
    expect(Object.keys(view[1]).sort()).toEqual(
      ["createdAt", "gmailMessageId", "id", "outcome", "reason"].sort(),
    );
  });

  it("an unknown stored code gives no reason instead of raw text", () => {
    const view = toSendHistoryView([
      {
        id: "x",
        outcome: "failed",
        errorCode: "Bearer abc.def.ghi",
        gmailMessageId: null,
        createdAt: new Date(),
      },
    ]);
    expect(view[0].reason).toBeNull();
    expect(JSON.stringify(view)).not.toContain("Bearer");
  });
});
