import fs from "fs";
import path from "path";
import type { PrismaClient } from "@prisma/client";
import { encrypt } from "@/lib/encryption";
import type { GmailClient } from "@/lib/cockpit/gmail/client";

// Seed + mock helpers for the send tests. Synthetic data only. Needs
// ENCRYPTION_KEY set (for the stored refresh token) before seedSend().

export const REFRESH_TOKEN = "REFRESH-TOKEN-SECRET";
export const ACCESS_TOKEN = "ACCESS-TOKEN-SECRET";
export const ADDRESS = "you@example.com";

export const pdfBytes = Buffer.concat([
  Buffer.from("%PDF-1.4\n"),
  Buffer.alloc(300, 9),
]);

// Never reaches Google: every method is a mock.
export function mockGmail() {
  return {
    getAccessToken: vi.fn<GmailClient["getAccessToken"]>().mockResolvedValue(ACCESS_TOKEN),
    sendRaw: vi
      .fn<GmailClient["sendRaw"]>()
      .mockResolvedValue({ id: "gmail-msg-1", threadId: "gmail-thread-1" }),
    revoke: vi.fn<GmailClient["revoke"]>().mockResolvedValue(undefined),
  } satisfies GmailClient;
}

export async function seedSend(prisma: PrismaClient, uploadsDir: string) {
  const mkUser = async (email: string, withGmail: boolean) => {
    const user = await prisma.user.create({
      data: { name: "Jane Doe", email, password: "x" },
    });
    const title = await prisma.jobTitle.create({
      data: { label: "Engineer", value: `eng-${user.id}`, createdBy: user.id },
    });
    const company = await prisma.company.create({
      data: { label: "Example Corp", value: `corp-${user.id}`, createdBy: user.id },
    });
    if (withGmail) {
      const { encrypted, iv } = encrypt(REFRESH_TOKEN);
      await prisma.gmailAccount.create({
        data: {
          userId: user.id,
          email: ADDRESS,
          encryptedRefreshToken: encrypted,
          iv,
          scopes: "https://www.googleapis.com/auth/gmail.send",
        },
      });
    }
    return { id: user.id, titleId: title.id, companyId: company.id };
  };

  const userA = await mkUser("jane@example.com", true);
  const userNoGmail = await mkUser("john@example.com", false);
  const draft = await prisma.jobStatus.create({
    data: { label: "Draft", value: "draft" },
  });
  const applied = await prisma.jobStatus.create({
    data: { label: "Applied", value: "applied" },
  });

  const newJob = async (u = userA) =>
    (
      await prisma.job.create({
        data: {
          userId: u.id,
          description: "A synthetic job",
          jobType: "FT",
          createdAt: new Date(),
          statusId: draft.id,
          jobTitleId: u.titleId,
          companyId: u.companyId,
        },
      })
    ).id;

  // A real PDF file under the user's cockpit dir, and its File row.
  const mkFile = async (u = userA) => {
    const dir = path.join(uploadsDir, "files", "cockpit", u.id);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(filePath, pdfBytes);
    const row = await prisma.file.create({
      data: { fileName: "cv.pdf", filePath, fileType: "application/pdf" },
    });
    return row.id;
  };

  let version = 0;
  const mkApproved = async (
    over: Record<string, unknown> = {},
    u = userA,
  ) => {
    const jobId = (over.jobId as string | undefined) ?? (await newJob(u));
    return prisma.applicationPackage.create({
      data: {
        userId: u.id,
        jobId,
        version: ++version,
        status: "approved",
        emailTo: "jobs@example.com",
        emailSubject: "Application – Engineer",
        emailBody: "Hello,\nI am Jane Doe.\nBODY-SECRET-TEXT",
        cvFileId: await mkFile(u),
        approvedAt: new Date(),
        ...over,
      },
    });
  };

  return { userA, userNoGmail, draft, applied, newJob, mkFile, mkApproved };
}
