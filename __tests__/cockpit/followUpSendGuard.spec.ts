// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";

// The follow-up send path (F-4, D-042): a threaded reply with no attachment,
// the send-time recheck, the per-kind active version, the wrong-combination
// refusals, and "a follow-up never changes the job" on all three paths.
// Gmail is always a mock: no test reaches Google.

const db = await vi.hoisted(async () => {
  const { createCockpitTestDb } = await import("./helpers/sqlite");
  return createCockpitTestDb();
});
const uploads = vi.hoisted(() => ({ dir: "" }));
// Lets a test make the recheck fail on its N-th call (the one under the lock).
const dueHook = vi.hoisted(() => ({ calls: 0, failOnCall: 0 }));

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
vi.mock("@/lib/cockpit/followUps", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/cockpit/followUps")>();
  return {
    ...mod,
    getFollowUpDue: vi.fn(async (...args: Parameters<typeof mod.getFollowUpDue>) => {
      dueHook.calls++;
      if (dueHook.failOnCall && dueHook.calls === dueHook.failOnCall) {
        return { eligible: false as const, reason: "outcome" as const };
      }
      return mod.getFollowUpDue(...args);
    }),
  };
});

import {
  markSendUnknownAsSent,
  releaseSendLock,
  sendApplicationPackage,
} from "@/lib/cockpit/send";
import { markPackageAppliedManually } from "@/lib/cockpit/packages";
import { ACCESS_TOKEN, ADDRESS, mockGmail, seedSend } from "./helpers/sendFixtures";

const prisma = db.prisma;
let s: Awaited<ReturnType<typeof seedSend>>;
const DAY = 24 * 60 * 60 * 1000;
const APPLIED_DATE = new Date("2026-01-05T09:00:00Z");

beforeAll(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  uploads.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-fusg-"));
  s = await seedSend(prisma, uploads.dir);
  await prisma.jobStatus.create({ data: { label: "Interview", value: "interview" } });
}, 120_000);
afterAll(async () => {
  fs.rmSync(uploads.dir, { recursive: true, force: true });
  await db.cleanup();
});
beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", ADDRESS);
  dueHook.calls = 0;
  dueHook.failOnCall = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const jobOf = (id: string) =>
  prisma.job.findUniqueOrThrow({ where: { id }, include: { Status: true } });
const row = (id: string) => prisma.applicationPackage.findUniqueOrThrow({ where: { id } });
const mimeOf = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
const headerOf = (mime: string, name: string) =>
  mime
    .split("\r\n\r\n")[0]
    .split("\r\n")
    .find((l) => l.startsWith(`${name}: `))
    ?.slice(name.length + 2);
// The Subject header, RFC 2047 words decoded (the test subject has an en dash).
const subjectOf = (mime: string) =>
  (headerOf(mime, "Subject") ?? "").replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/g, (_m, b64: string) =>
    Buffer.from(b64, "base64").toString("utf8"),
  );

// An applied job with a sent email application 10 days ago (step 1 due) and an
// approved follow-up draft replying to it.
async function seedFollowUp(
  opts: {
    sentEmail?: boolean;
    messageIdHeader?: string | null;
    follow?: Record<string, unknown>;
  } = {},
) {
  const jobId = await s.newJob();
  await prisma.job.update({
    where: { id: jobId },
    data: { statusId: s.applied.id, applied: true, appliedDate: APPLIED_DATE },
  });
  const sentAt = new Date(Date.now() - 10 * DAY);
  const app = await s.mkApproved({
    jobId,
    kind: "application",
    version: 1,
    status: "sent",
    sentAt,
    sentVia: "gmail",
  });
  if (opts.sentEmail !== false) {
    await prisma.sentEmail.create({
      data: {
        userId: s.userA.id,
        packageId: app.id,
        fromAddress: ADDRESS,
        toAddress: "jobs@example.com",
        gmailMessageId: "orig-msg",
        threadId: "thread-abc",
        messageIdHeader:
          opts.messageIdHeader === undefined ? "<orig-1@jobsync.local>" : opts.messageIdHeader,
        sentAt,
      },
    });
  }
  const fu = await s.mkApproved({
    jobId,
    kind: "follow_up",
    version: 1,
    cvFileId: null,
    replyToPackageId: app.id,
    emailSubject: "Re: Application – Engineer",
    emailBody: "Hello again,\nany news?",
    ...opts.follow,
  });
  return { jobId, app, fu };
}

const expectNotSent = async (gmail: ReturnType<typeof mockGmail>, id: string) => {
  expect(gmail.sendRaw).not.toHaveBeenCalled();
  expect(await row(id)).toMatchObject({ status: "approved", sendStartedAt: null });
  expect(await prisma.sentEmail.count({ where: { packageId: id } })).toBe(0);
};

describe("sending a follow-up: a threaded reply, no attachment", () => {
  it("replies in the application's thread with In-Reply-To / References, text/plain, no CV", async () => {
    const { jobId, fu } = await seedFollowUp();
    const gmail = mockGmail();
    await sendApplicationPackage(s.userA.id, fu.id, fu.updatedAt, gmail);

    expect(gmail.sendRaw).toHaveBeenCalledTimes(1);
    const [token, raw, threadId] = gmail.sendRaw.mock.calls[0];
    expect(token).toBe(ACCESS_TOKEN);
    expect(threadId).toBe("thread-abc");
    const mime = mimeOf(raw);
    expect(subjectOf(mime)).toBe("Re: Application – Engineer");
    expect(headerOf(mime, "In-Reply-To")).toBe("<orig-1@jobsync.local>");
    expect(headerOf(mime, "References")).toBe("<orig-1@jobsync.local>");
    expect(headerOf(mime, "Content-Type")).toBe("text/plain; charset=UTF-8");
    expect(mime).not.toContain("multipart");
    expect(mime).not.toContain("Content-Disposition: attachment");

    expect(await row(fu.id)).toMatchObject({ status: "sent", sentVia: "gmail", sendOutcome: null });
    const sent = await prisma.sentEmail.findUniqueOrThrow({ where: { packageId: fu.id } });
    expect(sent.messageIdHeader).toBe(headerOf(mime, "Message-ID"));
    expect(await prisma.sendAttempt.count({ where: { packageId: fu.id, outcome: "sent" } })).toBe(1);

    // A follow-up never changes the job.
    const job = await jobOf(jobId);
    expect(job.Status?.value).toBe("applied");
    expect(job.appliedDate?.toISOString()).toBe(APPLIED_DATE.toISOString());
  });

  it("adds 'Re: ' when the owner removed it", async () => {
    const { fu } = await seedFollowUp({ follow: { emailSubject: "Application – Engineer" } });
    const gmail = mockGmail();
    await sendApplicationPackage(s.userA.id, fu.id, fu.updatedAt, gmail);
    expect(subjectOf(mimeOf(gmail.sendRaw.mock.calls[0][1]))).toBe("Re: Application – Engineer");
  });

  it("no SentEmail on the application (marked sent by hand): no thread id, no In-Reply-To", async () => {
    const { fu } = await seedFollowUp({ sentEmail: false });
    const gmail = mockGmail();
    await sendApplicationPackage(s.userA.id, fu.id, fu.updatedAt, gmail);
    const call = gmail.sendRaw.mock.calls[0];
    expect(call).toHaveLength(2);
    expect(headerOf(mimeOf(call[1]), "In-Reply-To")).toBeUndefined();
  });

  it.each([
    ["missing (pre-V1 send)", null],
    ["not a strict Message-ID", "<a b@jobsync.local>"],
    ["header injection", "<a@jobsync.local>\r\nBcc: x@evil.example"],
  ])("stored Message-ID %s: no In-Reply-To, still threaded by id", async (_n, header) => {
    const { fu } = await seedFollowUp({ messageIdHeader: header });
    const gmail = mockGmail();
    await sendApplicationPackage(s.userA.id, fu.id, fu.updatedAt, gmail);
    const [, raw, threadId] = gmail.sendRaw.mock.calls[0];
    expect(threadId).toBe("thread-abc");
    const mime = mimeOf(raw);
    expect(headerOf(mime, "In-Reply-To")).toBeUndefined();
    expect(mime).not.toContain("evil.example");
  });

  it("an application send stores the Message-ID it sent", async () => {
    const app = await s.mkApproved({ kind: "application" });
    const gmail = mockGmail();
    await sendApplicationPackage(s.userA.id, app.id, app.updatedAt, gmail);
    const mime = mimeOf(gmail.sendRaw.mock.calls[0][1]);
    expect(gmail.sendRaw.mock.calls[0]).toHaveLength(2);
    const sent = await prisma.sentEmail.findUniqueOrThrow({ where: { packageId: app.id } });
    expect(sent.messageIdHeader).toBe(headerOf(mime, "Message-ID"));
    expect(sent.messageIdHeader).toMatch(/^<[^@\s]+@jobsync\.local>$/);
    expect(mime).toContain("multipart/mixed");
  });

  it("an ambiguous Gmail failure keeps the lock; Mark as sent counts it without touching the job", async () => {
    const { jobId, fu } = await seedFollowUp();
    const gmail = mockGmail();
    gmail.sendRaw.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      sendApplicationPackage(s.userA.id, fu.id, fu.updatedAt, gmail),
    ).rejects.toMatchObject({ code: "SEND_OUTCOME_UNKNOWN" });
    const r = await row(fu.id);
    expect(r.status).toBe("approved");
    expect(r.sendStartedAt).not.toBeNull();
    expect(r.sendOutcome).toBe("unknown");
    // A second send is refused while the lock is held.
    await expect(
      sendApplicationPackage(s.userA.id, fu.id, r.updatedAt, mockGmail()),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await markSendUnknownAsSent(s.userA.id, fu.id);
    expect(await row(fu.id)).toMatchObject({ status: "sent", sentVia: "manual" });
    const job = await jobOf(jobId);
    expect(job.Status?.value).toBe("applied");
    expect(job.appliedDate?.toISOString()).toBe(APPLIED_DATE.toISOString());
    expect(
      await prisma.sendAttempt.count({ where: { packageId: fu.id, outcome: "marked_sent" } }),
    ).toBe(1);
  });

  it("the stale updatedAt the user saw is still refused", async () => {
    const { fu } = await seedFollowUp();
    const gmail = mockGmail();
    await expect(
      sendApplicationPackage(s.userA.id, fu.id, new Date(fu.updatedAt.getTime() - 1000), gmail),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expectNotSent(gmail, fu.id);
  });
});

describe("send-time recheck: a follow-up that is no longer wanted is refused (CONFLICT)", () => {
  const refuse = async (fuId: string, at: Date) => {
    const gmail = mockGmail();
    await expect(sendApplicationPackage(s.userA.id, fuId, at, gmail)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expectNotSent(gmail, fuId);
    expect(gmail.getAccessToken).not.toHaveBeenCalled();
  };

  it("an outcome is recorded", async () => {
    const { jobId, fu } = await seedFollowUp();
    await prisma.jobFollowUp.create({
      data: { userId: s.userA.id, jobId, outcome: "replied", outcomeAt: new Date() },
    });
    await refuse(fu.id, fu.updatedAt);
  });

  it("follow-ups are stopped", async () => {
    const { jobId, fu } = await seedFollowUp();
    await prisma.jobFollowUp.create({ data: { userId: s.userA.id, jobId, stopped: true } });
    await refuse(fu.id, fu.updatedAt);
  });

  it("the step was skipped (the next one is only scheduled)", async () => {
    const { jobId, fu } = await seedFollowUp();
    await prisma.jobFollowUp.create({
      data: { userId: s.userA.id, jobId, skippedThrough: 1, skippedAt: new Date() },
    });
    await refuse(fu.id, fu.updatedAt);
  });

  it("the job status changed", async () => {
    const { jobId, fu } = await seedFollowUp();
    const interview = await prisma.jobStatus.findUniqueOrThrow({ where: { value: "interview" } });
    await prisma.job.update({ where: { id: jobId }, data: { statusId: interview.id } });
    await refuse(fu.id, fu.updatedAt);
  });

  it("a newer follow-up version exists", async () => {
    const { jobId, app, fu } = await seedFollowUp();
    await s.mkApproved({
      jobId,
      kind: "follow_up",
      version: 2,
      status: "pending",
      cvFileId: null,
      replyToPackageId: app.id,
    });
    await refuse(fu.id, fu.updatedAt);
  });

  it("the original application is not sent", async () => {
    const { jobId, fu } = await seedFollowUp();
    const other = await s.mkApproved({ jobId, kind: "application", version: 2, status: "superseded" });
    const moved = await prisma.applicationPackage.update({
      where: { id: fu.id },
      data: { replyToPackageId: other.id },
    });
    await refuse(fu.id, moved.updatedAt);
  });

  it("the replied-to application belongs to another job", async () => {
    const a = await seedFollowUp();
    const b = await seedFollowUp();
    const moved = await prisma.applicationPackage.update({
      where: { id: a.fu.id },
      data: { replyToPackageId: b.app.id },
    });
    await refuse(a.fu.id, moved.updatedAt);
  });

  it("also under the lock: a change between the checks releases the lock, nothing is sent", async () => {
    const { fu } = await seedFollowUp();
    dueHook.failOnCall = 2; // the first recheck passes, the one under the lock fails
    const gmail = mockGmail();
    await expect(
      sendApplicationPackage(s.userA.id, fu.id, fu.updatedAt, gmail),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dueHook.calls).toBe(2);
    await expectNotSent(gmail, fu.id);
    expect(
      await prisma.sendAttempt.findFirst({
        where: { packageId: fu.id },
        select: { outcome: true, errorCode: true },
      }),
    ).toEqual({ outcome: "failed", errorCode: "CONFLICT" });
  });
});

describe("wrong kind / field combinations are refused (INVALID_STATE)", () => {
  const refuseInvalid = async (id: string, at: Date) => {
    const gmail = mockGmail();
    await expect(sendApplicationPackage(s.userA.id, id, at, gmail)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expectNotSent(gmail, id);
  };

  it("a follow-up that carries a CV", async () => {
    const { fu } = await seedFollowUp();
    const withCv = await prisma.applicationPackage.update({
      where: { id: fu.id },
      data: { cvFileId: await s.mkFile() },
    });
    await refuseInvalid(fu.id, withCv.updatedAt);
  });

  it("a follow-up with no application to reply to", async () => {
    const { fu } = await seedFollowUp();
    const orphan = await prisma.applicationPackage.update({
      where: { id: fu.id },
      data: { replyToPackageId: null },
    });
    await refuseInvalid(fu.id, orphan.updatedAt);
  });

  it("an application that claims to reply to something", async () => {
    const other = await s.mkApproved({ kind: "application" });
    const app = await s.mkApproved({ kind: "application", replyToPackageId: other.id });
    await refuseInvalid(app.id, app.updatedAt);
  });

  it("an unknown kind", async () => {
    const odd = await s.mkApproved({ kind: "something_else" });
    await refuseInvalid(odd.id, odd.updatedAt);
  });

  it("an application still needs its CV", async () => {
    const app = await s.mkApproved({ kind: "application", cvFileId: null });
    const gmail = mockGmail();
    await expect(
      sendApplicationPackage(s.userA.id, app.id, app.updatedAt, gmail),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await expectNotSent(gmail, app.id);
  });
});

describe("a follow-up never marks the job applied (recovery and manual paths)", () => {
  it("'Mark applied manually' refuses a follow-up and leaves the job alone", async () => {
    const jobId = await s.newJob();
    const fu = await s.mkApproved({ jobId, kind: "follow_up", version: 1, emailTo: null });
    await expect(markPackageAppliedManually(s.userA.id, fu.id)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    const j = await jobOf(jobId);
    expect(j.Status?.value).toBe("draft");
    expect(j.appliedDate).toBeNull();
  });

  it("recovery 'mark as sent' on a locked follow-up: sent, but the job is untouched", async () => {
    const jobId = await s.newJob();
    const fu = await s.mkApproved({
      jobId,
      kind: "follow_up",
      version: 1,
      cvFileId: null,
      sendStartedAt: new Date(),
      sendOutcome: "unknown",
    });
    await markSendUnknownAsSent(s.userA.id, fu.id);
    expect((await row(fu.id)).status).toBe("sent");
    const j = await jobOf(jobId);
    expect(j.Status?.value).toBe("draft");
    expect(j.appliedDate).toBeNull();
    expect(await prisma.sentEmail.count({ where: { packageId: fu.id } })).toBe(0);
  });

  it("recovery 'unblock' on a locked follow-up: approved again", async () => {
    const fu = await s.mkApproved({
      kind: "follow_up",
      version: 1,
      cvFileId: null,
      sendStartedAt: new Date(),
      sendOutcome: "unknown",
    });
    await releaseSendLock(s.userA.id, fu.id);
    expect(await row(fu.id)).toMatchObject({ status: "approved", sendStartedAt: null });
  });

  it("recovery 'mark as sent' on an application still marks the job applied", async () => {
    const jobId = await s.newJob();
    const app = await s.mkApproved({
      jobId,
      kind: "application",
      sendStartedAt: new Date(),
      sendOutcome: "unknown",
    });
    await markSendUnknownAsSent(s.userA.id, app.id);
    expect((await jobOf(jobId)).Status?.value).toBe("applied");
  });
});
