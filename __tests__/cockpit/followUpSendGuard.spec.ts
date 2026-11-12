// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";

// D-031 review: until F-4 the V0 send/recovery paths are kind-blind, so a
// follow-up package that arrives through a hand-made v2 backup must never be
// sent as an application, nor mark the job applied.

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

import { markSendUnknownAsSent, sendApplicationPackage } from "@/lib/cockpit/send";
import { markPackageAppliedManually } from "@/lib/cockpit/packages";
import { ADDRESS, mockGmail, seedSend } from "./helpers/sendFixtures";

const prisma = db.prisma;
let s: Awaited<ReturnType<typeof seedSend>>;

beforeAll(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  uploads.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-fusg-"));
  s = await seedSend(prisma, uploads.dir);
}, 120_000);
afterAll(async () => {
  fs.rmSync(uploads.dir, { recursive: true, force: true });
  await db.cleanup();
});
beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-placeholder");
  vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", ADDRESS);
});
afterEach(() => vi.unstubAllEnvs());

const jobOf = (id: string) =>
  prisma.job.findUniqueOrThrow({ where: { id }, include: { Status: true } });

describe("a follow-up package cannot use the V0 application paths", () => {
  it("an approved follow-up (even with a CV and the highest version) is not sent", async () => {
    const jobId = await s.newJob();
    await s.mkApproved({ jobId, kind: "application", version: 1, status: "superseded" });
    const fu = await s.mkApproved({ jobId, kind: "follow_up", version: 1 });
    const gmail = mockGmail();
    await expect(sendApplicationPackage(s.userA.id, fu.id, fu.updatedAt, gmail)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect(gmail.sendRaw).not.toHaveBeenCalled();
    expect(gmail.getAccessToken).not.toHaveBeenCalled();
    expect(await prisma.applicationPackage.findUniqueOrThrow({ where: { id: fu.id } })).toMatchObject({
      status: "approved",
      sendStartedAt: null,
    });
    expect((await jobOf(jobId)).Status?.value).toBe("draft");
  });

  it("an application still sends (guard is kind-specific)", async () => {
    const app = await s.mkApproved({ kind: "application" });
    const gmail = mockGmail();
    await sendApplicationPackage(s.userA.id, app.id, app.updatedAt, gmail);
    expect(gmail.sendRaw).toHaveBeenCalledTimes(1);
  });

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

  it("recovery 'mark as sent' refuses a locked follow-up and leaves the job alone", async () => {
    const jobId = await s.newJob();
    const fu = await s.mkApproved({
      jobId,
      kind: "follow_up",
      version: 1,
      sendStartedAt: new Date(),
      sendOutcome: "unknown",
    });
    await expect(markSendUnknownAsSent(s.userA.id, fu.id)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect((await jobOf(jobId)).Status?.value).toBe("draft");
    expect(
      (await prisma.applicationPackage.findUniqueOrThrow({ where: { id: fu.id } })).status,
    ).toBe("approved");
  });
});
