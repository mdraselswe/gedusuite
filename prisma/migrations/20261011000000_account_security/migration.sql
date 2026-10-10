-- Phase 1: account security. Additive only.

-- Void-before marker for sessions (set by password reset).
ALTER TABLE "User" ADD COLUMN "sessionsValidAfter" TIMESTAMP(3);

-- Throttling counters.
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "RateLimit_resetAt_idx" ON "RateLimit"("resetAt");

-- Everyone who already has an account was onboarded by hand and is a known
-- person. Mark them verified so introducing email verification locks nobody
-- out; only accounts created from now on have to prove their inbox.
UPDATE "User" SET "emailVerified" = "createdAt" WHERE "emailVerified" IS NULL;
