-- Issue #75 / D-026: deleting a Job must never delete the history of what was sent.
-- ApplicationPackage.job goes from ON DELETE CASCADE to ON DELETE RESTRICT.
-- Table redefinition only (SQLite cannot alter a foreign key); rows are copied.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ApplicationPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "emailTo" TEXT,
    "emailSubject" TEXT NOT NULL,
    "emailBody" TEXT NOT NULL,
    "letterMd" TEXT,
    "fitGrade" TEXT,
    "fitAnalysis" TEXT,
    "cvJson" TEXT,
    "cvFileId" TEXT,
    "cvPdfStale" BOOLEAN NOT NULL DEFAULT false,
    "sourceFolder" TEXT,
    "idempotencyKey" TEXT,
    "rejectReason" TEXT,
    "changeRequest" TEXT,
    "changeRequestedAt" DATETIME,
    "changeRequestHandledAt" DATETIME,
    "changeRequestResponse" TEXT,
    "editedAt" DATETIME,
    "approvedAt" DATETIME,
    "rejectedAt" DATETIME,
    "sendStartedAt" DATETIME,
    "sendOutcome" TEXT,
    "sentAt" DATETIME,
    "sentVia" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplicationPackage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApplicationPackage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApplicationPackage_cvFileId_fkey" FOREIGN KEY ("cvFileId") REFERENCES "File" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ApplicationPackage" ("approvedAt", "changeRequest", "changeRequestHandledAt", "changeRequestResponse", "changeRequestedAt", "createdAt", "cvFileId", "cvJson", "cvPdfStale", "editedAt", "emailBody", "emailSubject", "emailTo", "fitAnalysis", "fitGrade", "id", "idempotencyKey", "jobId", "letterMd", "rejectReason", "rejectedAt", "sendOutcome", "sendStartedAt", "sentAt", "sentVia", "sourceFolder", "status", "updatedAt", "userId", "version") SELECT "approvedAt", "changeRequest", "changeRequestHandledAt", "changeRequestResponse", "changeRequestedAt", "createdAt", "cvFileId", "cvJson", "cvPdfStale", "editedAt", "emailBody", "emailSubject", "emailTo", "fitAnalysis", "fitGrade", "id", "idempotencyKey", "jobId", "letterMd", "rejectReason", "rejectedAt", "sendOutcome", "sendStartedAt", "sentAt", "sentVia", "sourceFolder", "status", "updatedAt", "userId", "version" FROM "ApplicationPackage";
DROP TABLE "ApplicationPackage";
ALTER TABLE "new_ApplicationPackage" RENAME TO "ApplicationPackage";
CREATE INDEX "ApplicationPackage_userId_status_createdAt_idx" ON "ApplicationPackage"("userId", "status", "createdAt");
CREATE UNIQUE INDEX "ApplicationPackage_jobId_version_key" ON "ApplicationPackage"("jobId", "version");
CREATE UNIQUE INDEX "ApplicationPackage_userId_idempotencyKey_key" ON "ApplicationPackage"("userId", "idempotencyKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

