-- Phase 3: plans and billing. Additive only.

CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'SUSPENDED', 'CANCELLED');
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY');
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PAID', 'REJECTED', 'VOID');

CREATE TABLE "Subscription" (
    "workspaceId" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "cycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("workspaceId")
);

CREATE TABLE "BillingInvoice" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "cycle" "BillingCycle" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "method" TEXT,
    "senderNumber" TEXT,
    "trxId" TEXT,
    "note" TEXT,
    "rejectReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingInvoice_number_key" ON "BillingInvoice"("number");
CREATE INDEX "BillingInvoice_workspaceId_idx" ON "BillingInvoice"("workspaceId");
CREATE INDEX "BillingInvoice_status_idx" ON "BillingInvoice"("status");

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every workspace that exists today predates billing. It is grandfathered onto
-- the LEGACY plan: unlimited, never expires. Nothing about how it works changes.
INSERT INTO "Subscription" ("workspaceId", "planKey", "status", "cycle", "updatedAt")
SELECT "id", 'LEGACY', 'ACTIVE', 'MONTHLY', CURRENT_TIMESTAMP FROM "Workspace";
