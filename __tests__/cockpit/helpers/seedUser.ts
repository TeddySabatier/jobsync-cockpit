import type { PrismaClient } from "@prisma/client";

// Shared seed for the cockpit DB specs. Synthetic data only. The title and
// company values carry the user id, so several users can coexist in one DB.

export type SeededUser = { id: string; titleId: string; companyId: string };

export async function seedUserWithRefs(
  prisma: PrismaClient,
  email: string,
): Promise<SeededUser> {
  const user = await prisma.user.create({
    data: { name: "Jane Doe", email, password: "x" },
  });
  const title = await prisma.jobTitle.create({
    data: { label: "Engineer", value: `eng-${user.id}`, createdBy: user.id },
  });
  const company = await prisma.company.create({
    data: { label: "Example Corp", value: `corp-${user.id}`, createdBy: user.id },
  });
  return { id: user.id, titleId: title.id, companyId: company.id };
}

// A minimal job owned by `user`, in the given status. Returns the job id.
export async function createJobFor(
  prisma: PrismaClient,
  user: SeededUser,
  statusId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const job = await prisma.job.create({
    data: {
      userId: user.id,
      description: "A synthetic job",
      jobType: "FT",
      createdAt: new Date(),
      statusId,
      jobTitleId: user.titleId,
      companyId: user.companyId,
      ...over,
    },
  });
  return job.id;
}
