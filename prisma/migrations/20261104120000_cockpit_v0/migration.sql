-- Cockpit V0 (cockpit/SPEC.md §2): application packages submitted by an
-- external bot, the single user's Gmail connection, and the sent-email log.
-- Additive, pure DDL: new tables and indexes only, no change to existing
-- tables and no data statements.

-- CreateTable
CREATE TABLE "ApplicationPackage" (
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
    CONSTRAINT "ApplicationPackage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApplicationPackage_cvFileId_fkey" FOREIGN KEY ("cvFileId") REFERENCES "File" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GmailAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GmailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SentEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SentEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SentEmail_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ApplicationPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ApplicationPackage_userId_status_createdAt_idx" ON "ApplicationPackage"("userId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationPackage_jobId_version_key" ON "ApplicationPackage"("jobId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationPackage_userId_idempotencyKey_key" ON "ApplicationPackage"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "GmailAccount_userId_key" ON "GmailAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SentEmail_packageId_key" ON "SentEmail"("packageId");
