-- Phase 2: per-workspace website integration. Additive only.
CREATE TABLE "WorkspaceIntegration" (
    "workspaceId" TEXT NOT NULL,
    "wooUrl" TEXT,
    "wooConsumerKeyEnc" TEXT,
    "wooConsumerSecretEnc" TEXT,
    "wooWriteKeyEnc" TEXT,
    "wooWriteSecretEnc" TEXT,
    "wooWebhookSecretEnc" TEXT,
    "hookToken" TEXT,
    "cartBeaconSecretEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkspaceIntegration_pkey" PRIMARY KEY ("workspaceId")
);

CREATE UNIQUE INDEX "WorkspaceIntegration_hookToken_key" ON "WorkspaceIntegration"("hookToken");

ALTER TABLE "WorkspaceIntegration" ADD CONSTRAINT "WorkspaceIntegration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
