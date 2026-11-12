-- UX flow B (D-041): where the recipient address was found, supplied by the bot
-- and shown next to the recipient in Review. Purely additive: one nullable
-- column, no default, no existing row is touched.
-- AlterTable
ALTER TABLE "ApplicationPackage" ADD COLUMN "contactSource" TEXT;
