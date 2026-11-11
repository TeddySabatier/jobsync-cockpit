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

vi.mock("@/lib/cockpit/letterPdf", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/cockpit/letterPdf")>();
  return { ...mod, renderLetterPdf: vi.fn(mod.renderLetterPdf) };
});

import * as letterPdfModule from "@/lib/cockpit/letterPdf";
const renderSpy = vi.mocked(letterPdfModule.renderLetterPdf);
const realRender = (await vi.importActual<typeof import("@/lib/cockpit/letterPdf")>(
  "@/lib/cockpit/letterPdf",
)).renderLetterPdf;
import { CockpitError } from "@/lib/cockpit/errors";
import {
  markSendUnknownAsSent,
  releaseSendLock,
  sendApplicationPackage,
} from "@/lib/cockpit/send";
import {
  approvePackage,
  markPackageAppliedManually,
  rejectPackage,
  requestPackageChanges,
  submitPackage,
  unapprovePackage,
  updatePackageContent,
} from "@/lib/cockpit/packages";
import {
  ACCESS_TOKEN,
  ADDRESS,
  mockGmail,
  pdfBytes,
  REFRESH_TOKEN,
  seedSend,
} from "./helpers/sendFixtures";

// AC-25, AC-26, AC-33, AC-34 against the real migration on a temp SQLite DB.
// The Gmail client is always a mock: no test reaches Google.
const prisma = db.prisma;
let s: Awaited<ReturnType<typeof seedSend>>;
let gmail: ReturnType<typeof mockGmail>;

const row = (id: string) =>
  prisma.applicationPackage.findUniqueOrThrow({ where: { id } });
const send = (id: string, at: Date, userId = s.userA.id) =>
  sendApplicationPackage(userId, id, at, gmail);
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as CockpitError;
  }
  throw new Error("expected a rejection");
};
const sentEmails = (packageId: string) =>
  prisma.sentEmail.count({ where: { packageId } });
const jobOf = (jobId: string) =>
  prisma.job.findUniqueOrThrow({ where: { id: jobId }, include: { Status: true } });

beforeAll(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  uploads.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-send-"));
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

describe("sendApplicationPackage: cover letter PDF (D-015)", () => {
  // Pulls every attachment (file name + decoded bytes) out of the raw message.
  const partsOf = (raw: string) => {
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    const parts: { name: string; bytes: Buffer }[] = [];
    for (const section of mime.split("Content-Disposition: attachment; filename=\"").slice(1)) {
      const name = section.slice(0, section.indexOf("\""));
      const bodyStart = section.indexOf("\r\n\r\n") + 4;
      const bodyEnd = section.indexOf("\r\n--", bodyStart);
      const b64 = section.slice(bodyStart, bodyEnd).replace(/\r\n/g, "");
      parts.push({ name, bytes: Buffer.from(b64, "base64") });
    }
    return parts;
  };
  const textOf = async (pdf: Buffer) => {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf)), {
      mergePages: true,
    });
    return text;
  };

  it("attaches a PDF made from the current letter text next to the CV", async () => {
    const pkg = await s.mkApproved({
      letterMd: "Dear team,\n\nLETTER-MARKER-TEXT",
      cvJson: JSON.stringify({ name: "Jane Doe", title: "Engineer", contact: ["jane@example.com"] }),
    });
    await send(pkg.id, pkg.updatedAt);
    const parts = partsOf(gmail.sendRaw.mock.calls[0][1]);
    expect(parts.map((x) => x.name)).toEqual(["Jane_Doe_CV.pdf", "Jane_Doe_Cover_Letter.pdf"]);
    expect(parts[0].bytes.equals(pdfBytes)).toBe(true);
    expect(parts[1].bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const text = await textOf(parts[1].bytes);
    expect(text).toContain("LETTER-MARKER-TEXT");
    expect(text).toContain("Jane Doe");
  });

  it("uses the letter as edited: the PDF is made at Send, not stored", async () => {
    const pkg = await s.mkApproved({ letterMd: "FIRST-VERSION" });
    await prisma.applicationPackage.update({
      where: { id: pkg.id },
      data: { letterMd: "EDITED-VERSION" },
    });
    await send(pkg.id, (await row(pkg.id)).updatedAt);
    const text = await textOf(partsOf(gmail.sendRaw.mock.calls[0][1])[1].bytes);
    expect(text).toContain("EDITED-VERSION");
    expect(text).not.toContain("FIRST-VERSION");
  });

  it("sends only the CV when there is no letter text", async () => {
    for (const letterMd of [null, "   \n "]) {
      gmail = mockGmail();
      const pkg = await s.mkApproved({ letterMd });
      await send(pkg.id, pkg.updatedAt);
      expect(partsOf(gmail.sendRaw.mock.calls[0][1]).map((x) => x.name)).toEqual(["Jane_Doe_CV.pdf"]);
    }
  });
});

describe("sendApplicationPackage: letter PDF and the lock (review findings)", () => {
  it("renders the letter before the lock is taken, never inside the lock window", async () => {
    const pkg = await s.mkApproved({ letterMd: "Dear team" });
    const seen: (Date | null)[] = [];
    renderSpy.mockImplementationOnce(async (input) => {
      seen.push((await row(pkg.id)).sendStartedAt);
      return realRender(input);
    });
    await send(pkg.id, pkg.updatedAt);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([null]);
  });

  it("a render failure returns INTERNAL, takes no lock and never calls Gmail", async () => {
    const pkg = await s.mkApproved({ letterMd: "Dear team" });
    renderSpy.mockRejectedValueOnce(new Error("boom"));
    const e = await rejection(send(pkg.id, pkg.updatedAt));
    expect(e).toMatchObject({ code: "INTERNAL" });
    expect(gmail.sendRaw).not.toHaveBeenCalled();
    expect(gmail.getAccessToken).not.toHaveBeenCalled();
    const after = await row(pkg.id);
    expect(after).toMatchObject({ status: "approved", sendStartedAt: null });
    // Nothing is stuck: the same package sends fine afterwards.
    await send(pkg.id, pkg.updatedAt);
    expect(gmail.sendRaw).toHaveBeenCalledOnce();
  });
});

describe("sendApplicationPackage: success (AC-25)", () => {
  it("sends the MIME, then sets package sent + SentEmail + job applied", async () => {
    const pkg = await s.mkApproved();
    const res = await send(pkg.id, pkg.updatedAt);

    expect(gmail.getAccessToken).toHaveBeenCalledExactlyOnceWith(REFRESH_TOKEN);
    expect(gmail.sendRaw).toHaveBeenCalledOnce();
    const [token, raw] = gmail.sendRaw.mock.calls[0];
    expect(token).toBe(ACCESS_TOKEN);
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain(`From: ${ADDRESS}\r\n`);
    expect(mime).toContain("To: jobs@example.com\r\n");
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/); // en dash is non-ASCII
    expect(mime).toContain(pdfBytes.toString("base64").slice(0, 60));
    // The recipient sees the sanitized display name, never the generated uuid.
    const file = await prisma.file.findUniqueOrThrow({ where: { id: pkg.cvFileId as string } });
    const uuidName = path.basename(file.filePath);
    expect(mime).toContain('Content-Type: application/pdf; name="Jane_Doe_CV.pdf"');
    expect(mime).toContain('filename="Jane_Doe_CV.pdf"');
    expect(mime).not.toContain(uuidName);
    expect(mime).toContain(
      Buffer.from("Hello,\r\nI am Jane Doe.\r\nBODY-SECRET-TEXT").toString("base64"),
    );

    const after = await row(pkg.id);
    expect(after).toMatchObject({
      status: "sent",
      sentVia: "gmail",
      sendOutcome: null,
    });
    expect(after.sentAt).toEqual(res.sentAt);
    const email = await prisma.sentEmail.findUniqueOrThrow({
      where: { packageId: pkg.id },
    });
    expect(email).toMatchObject({
      userId: s.userA.id,
      fromAddress: ADDRESS,
      toAddress: "jobs@example.com",
      gmailMessageId: "gmail-msg-1",
      threadId: "gmail-thread-1",
    });
    const job = await jobOf(pkg.jobId);
    expect(job).toMatchObject({ applied: true, statusId: s.applied.id });
    expect(job.appliedDate).toEqual(res.sentAt);
  });

  it("a failing transaction rolls everything back: lock stays, outcome unknown", async () => {
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
    const after = await row(pkg.id);
    expect(after.status).toBe("approved");
    expect(after.sendStartedAt).not.toBeNull();
    expect(after.sendOutcome).toBe("unknown");
    expect((await jobOf(pkg.jobId)).applied).toBe(false);
  });
});

describe("sendApplicationPackage: preconditions, nothing locked or sent", () => {
  const untouched = async (id: string, before: Date | null = null) => {
    expect(gmail.getAccessToken).not.toHaveBeenCalled();
    expect(gmail.sendRaw).not.toHaveBeenCalled();
    expect((await row(id)).sendStartedAt).toEqual(before);
  };

  it("CONFLICT when updatedAt changed since the dialog opened", async () => {
    const pkg = await s.mkApproved();
    const seen = pkg.updatedAt;
    await updatePackageContent(s.userA.id, pkg.id, { emailBody: "Edited" });
    expect(await rejection(send(pkg.id, seen))).toMatchObject({ code: "CONFLICT" });
    await untouched(pkg.id);
  });

  it("CONFLICT when the package is not approved", async () => {
    const pkg = await s.mkApproved({ status: "pending" });
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
      code: "CONFLICT",
    });
    await untouched(pkg.id);
  });

  it("CONFLICT when already locked", async () => {
    const lockedAt = new Date();
    const pkg = await s.mkApproved({ sendStartedAt: lockedAt });
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
      code: "CONFLICT",
    });
    await untouched(pkg.id, lockedAt);
  });

  it("CONFLICT for a version that is not the active one", async () => {
    const jobId = await s.newJob();
    const old = await s.mkApproved({ jobId });
    await s.mkApproved({ jobId, status: "pending" });
    expect(await rejection(send(old.id, old.updatedAt))).toMatchObject({
      code: "CONFLICT",
    });
    await untouched(old.id);
  });

  it("NOT_FOUND for another user's package", async () => {
    const pkg = await s.mkApproved();
    expect(
      await rejection(send(pkg.id, pkg.updatedAt, s.userNoGmail.id)),
    ).toMatchObject({ code: "NOT_FOUND" });
    await untouched(pkg.id);
  });

  it.each([
    ["comma in To", { emailTo: "a@example.com,b@example.com" }, "VALIDATION"],
    ["line break in To", { emailTo: "a@example.com\nBcc: b@example.com" }, "VALIDATION"],
    ["no recipient", { emailTo: null }, "VALIDATION"],
    ["line break in subject", { emailSubject: "Hi\r\nBcc: x@example.com" }, "VALIDATION"],
    ["stale PDF", { cvPdfStale: true }, "VALIDATION"],
    ["no CV file", { cvFileId: null }, "FILE_NOT_FOUND"],
  ])("%s is refused before any lock or Gmail call", async (_n, over, code) => {
    const pkg = await s.mkApproved(over);
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({ code });
    await untouched(pkg.id);
  });

  it("a CV file outside the user's cockpit dir is refused", async () => {
    const outside = path.join(uploads.dir, "elsewhere.pdf");
    fs.writeFileSync(outside, pdfBytes);
    const file = await prisma.file.create({
      data: { fileName: "x.pdf", filePath: outside, fileType: "application/pdf" },
    });
    const pkg = await s.mkApproved({ cvFileId: file.id });
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
      code: "FILE_NOT_FOUND",
    });
    await untouched(pkg.id);
  });

  it.each([
    ["different address", () => vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", "other@example.com")],
    ["unset allow-list", () => vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", "")],
  ])("%s: refused before any Gmail call", async (_n, arrange) => {
    arrange();
    const pkg = await s.mkApproved();
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
      code: "GMAIL_RECONNECT_REQUIRED",
    });
    await untouched(pkg.id);
  });

  it("allow-list match is case-insensitive", async () => {
    vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", "You@Example.com");
    const pkg = await s.mkApproved();
    await send(pkg.id, pkg.updatedAt);
    expect(gmail.sendRaw).toHaveBeenCalledOnce();
  });

  it("no connected Gmail account: refused before any Gmail call", async () => {
    const pkg = await s.mkApproved({}, s.userNoGmail);
    expect(
      await rejection(send(pkg.id, pkg.updatedAt, s.userNoGmail.id)),
    ).toMatchObject({ code: "GMAIL_RECONNECT_REQUIRED" });
    await untouched(pkg.id);
  });
});

describe("sendApplicationPackage: lock (AC-26)", () => {
  it("two concurrent sends: one wins the lock, the other gets CONFLICT", async () => {
    const pkg = await s.mkApproved();
    const results = await Promise.allSettled([
      send(pkg.id, pkg.updatedAt),
      send(pkg.id, pkg.updatedAt),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "CONFLICT" });
    expect(gmail.sendRaw).toHaveBeenCalledOnce();
    expect(await sentEmails(pkg.id)).toBe(1);
  });

  it("re-reads after the lock: content changed in between is caught, lock released", async () => {
    const pkg = await s.mkApproved();
    // Another writer changes the recipient right after our lock: a trigger
    // that fires when sendStartedAt is set, i.e. between the lock and the re-read.
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER tamper AFTER UPDATE OF sendStartedAt ON ApplicationPackage
       WHEN NEW.id = '${pkg.id}' AND NEW.sendStartedAt IS NOT NULL
       BEGIN UPDATE ApplicationPackage SET emailTo = 'a@example.com,b@example.com' WHERE id = NEW.id; END`,
    );
    const err = await rejection(send(pkg.id, pkg.updatedAt));
    await prisma.$executeRawUnsafe("DROP TRIGGER tamper");
    expect(err).toMatchObject({ code: "VALIDATION" });
    expect(gmail.sendRaw).not.toHaveBeenCalled();
    const after = await row(pkg.id);
    expect(after.emailTo).toBe("a@example.com,b@example.com"); // the tamper did happen
    expect(after.sendStartedAt).toBeNull();
    expect(after.status).toBe("approved");
  });
});

describe("sendApplicationPackage: definitive failures release the lock (AC-26)", () => {
  const released = async (id: string) => {
    const after = await row(id);
    expect(after).toMatchObject({
      status: "approved",
      sendStartedAt: null,
      sendOutcome: null,
    });
    expect(await sentEmails(id)).toBe(0);
  };

  it("token endpoint failure", async () => {
    const pkg = await s.mkApproved();
    gmail.getAccessToken.mockRejectedValue(
      new CockpitError("GMAIL_TOKEN", { status: 500, definitive: true }),
    );
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
      code: "GMAIL_TOKEN",
    });
    expect(gmail.sendRaw).not.toHaveBeenCalled();
    await released(pkg.id);
  });

  it("invalid_grant gives GMAIL_RECONNECT_REQUIRED", async () => {
    const pkg = await s.mkApproved();
    gmail.getAccessToken.mockRejectedValue(
      new CockpitError("GMAIL_RECONNECT_REQUIRED", { status: 400, definitive: true }),
    );
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
      code: "GMAIL_RECONNECT_REQUIRED",
    });
    await released(pkg.id);
  });

  it("decrypt failure (key changed) gives GMAIL_RECONNECT_REQUIRED without a Gmail call", async () => {
    const pkg = await s.mkApproved();
    vi.stubEnv("ENCRYPTION_KEY", "a-different-key-placeholder");
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
      code: "GMAIL_RECONNECT_REQUIRED",
    });
    expect(gmail.getAccessToken).not.toHaveBeenCalled();
    expect(gmail.sendRaw).not.toHaveBeenCalled();
    await released(pkg.id);
  });

  it.each([400, 401, 403])("Gmail %i on send", async (status) => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockRejectedValue(
      new CockpitError("GMAIL_SEND", { status, definitive: true }),
    );
    expect(await rejection(send(pkg.id, pkg.updatedAt))).toMatchObject({
      code: "GMAIL_SEND",
      status,
    });
    await released(pkg.id);
    // The package can be sent again after a definitive failure.
    const again = await row(pkg.id);
    gmail.sendRaw.mockResolvedValue({ id: "m2", threadId: "t2" });
    await send(pkg.id, again.updatedAt);
    expect((await row(pkg.id)).status).toBe("sent");
  });
});

describe("sendApplicationPackage: ambiguous failures keep the lock (AC-33)", () => {
  it.each([
    ["timeout", new CockpitError("GMAIL_TIMEOUT", { definitive: false })],
    ["5xx", new CockpitError("GMAIL_SEND", { status: 503, definitive: false })],
    ["429", new CockpitError("GMAIL_SEND", { status: 429, definitive: false })],
    ["unreadable 2xx", new CockpitError("GMAIL_SEND", { definitive: false })],
    ["network error", new CockpitError("GMAIL_SEND", { definitive: false })],
    ["unexpected error", new Error("socket hang up")],
  ])("%s: lock stays, sendOutcome unknown, SEND_OUTCOME_UNKNOWN", async (_n, failure) => {
    const pkg = await s.mkApproved();
    gmail.sendRaw.mockRejectedValue(failure);
    const err = await rejection(send(pkg.id, pkg.updatedAt));
    expect(err).toMatchObject({ code: "SEND_OUTCOME_UNKNOWN" });
    const after = await row(pkg.id);
    expect(after).toMatchObject({ status: "approved", sendOutcome: "unknown" });
    expect(after.sendStartedAt).not.toBeNull();
    expect(await sentEmails(pkg.id)).toBe(0);
    expect((await jobOf(pkg.jobId)).applied).toBe(false);

    // Locked: a second send is refused and Gmail is not called again.
    const calls = gmail.sendRaw.mock.calls.length;
    expect(await rejection(send(pkg.id, after.updatedAt))).toMatchObject({
      code: "CONFLICT",
    });
    expect(gmail.sendRaw.mock.calls.length).toBe(calls);
  });
});

describe("recovery actions (AC-33)", () => {
  const ago = (ms: number) => new Date(Date.now() - ms);

  it("markSendUnknownAsSent: unknown outcome -> sent manually, job applied, no SentEmail", async () => {
    const pkg = await s.mkApproved({ sendStartedAt: ago(5_000), sendOutcome: "unknown" });
    const res = await markSendUnknownAsSent(s.userA.id, pkg.id);
    expect(await row(pkg.id)).toMatchObject({
      status: "sent",
      sentVia: "manual",
      sendOutcome: null,
    });
    expect(await sentEmails(pkg.id)).toBe(0);
    const job = await jobOf(pkg.jobId);
    expect(job).toMatchObject({ applied: true, statusId: s.applied.id });
    expect(job.appliedDate).toEqual(res.sentAt);
  });

  it("a lock older than 60 s with no outcome is recoverable, a fresh one is not", async () => {
    const fresh = await s.mkApproved({ sendStartedAt: ago(30_000) });
    for (const fn of [markSendUnknownAsSent, releaseSendLock]) {
      expect(await rejection(fn(s.userA.id, fresh.id))).toMatchObject({
        code: "INVALID_STATE",
      });
    }
    expect((await row(fresh.id)).sendStartedAt).not.toBeNull();
    expect((await row(fresh.id)).status).toBe("approved");

    const stale = await s.mkApproved({ sendStartedAt: ago(61_000) });
    await markSendUnknownAsSent(s.userA.id, stale.id);
    expect((await row(stale.id)).status).toBe("sent");
    const stale2 = await s.mkApproved({ sendStartedAt: ago(61_000) });
    await releaseSendLock(s.userA.id, stale2.id);
    expect((await row(stale2.id)).sendStartedAt).toBeNull();
  });

  it("releaseSendLock clears lock and outcome; the package is approved again and sendable", async () => {
    const pkg = await s.mkApproved({ sendStartedAt: ago(5_000), sendOutcome: "unknown" });
    await releaseSendLock(s.userA.id, pkg.id);
    const after = await row(pkg.id);
    expect(after).toMatchObject({
      status: "approved",
      sendStartedAt: null,
      sendOutcome: null,
    });
    await send(pkg.id, after.updatedAt);
    expect((await row(pkg.id)).status).toBe("sent");
  });

  it.each([
    ["unlocked approved", { status: "approved" }],
    ["locked but pending", { status: "pending", sendStartedAt: new Date(Date.now() - 90_000) }],
    ["already sent", { status: "sent", sendStartedAt: new Date(Date.now() - 90_000) }],
  ])("%s: both actions give INVALID_STATE and change nothing", async (_n, over) => {
    const pkg = await s.mkApproved(over);
    const before = await row(pkg.id);
    for (const fn of [markSendUnknownAsSent, releaseSendLock]) {
      expect(await rejection(fn(s.userA.id, pkg.id))).toMatchObject({
        code: "INVALID_STATE",
      });
    }
    expect(await row(pkg.id)).toEqual(before);
    expect((await jobOf(pkg.jobId)).applied).toBe(false);
  });

  it("another user's or a missing package is NOT_FOUND", async () => {
    const pkg = await s.mkApproved({ sendStartedAt: ago(90_000), sendOutcome: "unknown" });
    for (const fn of [markSendUnknownAsSent, releaseSendLock]) {
      expect(await rejection(fn(s.userNoGmail.id, pkg.id))).toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await rejection(fn(s.userA.id, "missing"))).toMatchObject({
        code: "NOT_FOUND",
      });
    }
    expect((await row(pkg.id)).sendOutcome).toBe("unknown");
  });
});

describe("a locked package is frozen (AC-34)", () => {
  it("review transitions, edits and manual apply affect 0 rows; submit gives CONFLICT", async () => {
    const jobId = await s.newJob();
    const pkg = await s.mkApproved({
      jobId,
      emailTo: null,
      sendStartedAt: new Date(),
      sendOutcome: "unknown",
    });
    const before = await row(pkg.id);
    const uid = s.userA.id;
    const attempts: (() => Promise<unknown>)[] = [
      () => approvePackage(uid, pkg.id),
      () => unapprovePackage(uid, pkg.id),
      () => rejectPackage(uid, pkg.id, "no"),
      () => requestPackageChanges(uid, pkg.id, "change"),
      () => updatePackageContent(uid, pkg.id, { emailBody: "Edited" }),
      () => markPackageAppliedManually(uid, pkg.id),
    ];
    for (const a of attempts) {
      expect(await rejection(a())).toMatchObject({ code: "INVALID_STATE" });
    }
    expect(await rejection(
      submitPackage(uid, {
        jobId,
        emailSubject: "New",
        emailBody: "New",
        fitGrade: "A",
      }),
    )).toMatchObject({ code: "CONFLICT" });
    expect(await row(pkg.id)).toEqual(before);
    expect((await jobOf(jobId)).applied).toBe(false);
  });
});
