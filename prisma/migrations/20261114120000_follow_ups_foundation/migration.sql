-- D-030 / follow-ups 1/4: data model for application follow-ups. Pure DDL, no
-- table is redefined or copied (ADD COLUMN, one new table, one index swapped),
-- so every existing row stays as it is: kind = application for all of them.

-- ApplicationPackage: a package is an application or a follow-up to one.
ALTER TABLE "ApplicationPackage" ADD COLUMN "kind" TEXT NOT NULL DEFAULT application;
ALTER TABLE "ApplicationPackage" ADD COLUMN "replyToPackageId" TEXT;

-- Versions are numbered per (job, kind). The old unique index is a subset of
-- the new one for existing rows (all kind = application), so the swap cannot
-- fail on existing data.
DROP INDEX "ApplicationPackage_jobId_version_key";
CREATE UNIQUE INDEX "ApplicationPackage_jobId_kind_version_key" ON "ApplicationPackage"("jobId", "kind", "version");

-- SentEmail: the Message-ID header we generated, for In-Reply-To / References.
ALTER TABLE "SentEmail" ADD COLUMN "messageIdHeader" TEXT;

-- CreateTable
CREATE TABLE "JobFollowUp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "outcome" TEXT,
    "outcomeAt" DATETIME,
    "stopped" BOOLEAN NOT NULL DEFAULT false,
    "skippedThrough" INTEGER NOT NULL DEFAULT 0,
    "skippedAt" DATETIME,
    "snoozedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "JobFollowUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "JobFollowUp_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "JobFollowUp_jobId_key" ON "JobFollowUp"("jobId");

-- CreateIndex
CREATE INDEX "JobFollowUp_userId_idx" ON "JobFollowUp"("userId");
