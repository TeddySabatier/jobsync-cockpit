-- Issue #77 / D-028: append-only history of send attempts. Purely additive:
-- one new table and one index, no existing table is touched or copied.
-- CreateTable
CREATE TABLE "SendAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "gmailMessageId" TEXT,
    "threadId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SendAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SendAttempt_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ApplicationPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SendAttempt_packageId_createdAt_idx" ON "SendAttempt"("packageId", "createdAt");
