// Shared Prisma `include` for a full resume with relations, as consumed by
// preprocessResume/convertResumeToText. Extracted so both the session-scoped
// getResumeById (profile.actions.ts) and the userId-scoped
// getDefaultResumeForUser (MCP path) stay in sync. profile.actions.ts has
// "use server" at the top, which only allows async-function exports, so this
// object can't live there directly.
// File without filePath: the stored path never reaches a client (issue #78);
// downloads go by File id through /api/profile/resume.
export const clientFileSelect = {
  id: true,
  fileName: true,
  fileType: true,
  uploadedAt: true,
} as const;

export const resumeDetailInclude = {
  ContactInfo: true,
  File: { select: clientFileSelect },
  ResumeSections: {
    include: {
      summary: true,
      workExperiences: {
        include: {
          jobTitle: true,
          Company: true,
          location: true,
        },
      },
      educations: {
        include: {
          location: true,
        },
      },
      licenseOrCertifications: true,
      skills: { include: { Tag: true } },
    },
  },
} as const;
