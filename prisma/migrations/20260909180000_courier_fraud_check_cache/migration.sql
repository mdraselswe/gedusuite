-- Cache Steadfast fraud-check answers so page reloads do not keep hitting the
-- courier's rate limit.
CREATE TABLE "CourierFraudCheck" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "totalParcels" INTEGER NOT NULL DEFAULT 0,
    "totalDelivered" INTEGER NOT NULL DEFAULT 0,
    "totalCancelled" INTEGER NOT NULL DEFAULT 0,
    "totalFraudReports" JSONB NOT NULL DEFAULT '[]',
    "checkedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "errorAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierFraudCheck_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierFraudCheck_workspaceId_phone_key" ON "CourierFraudCheck"("workspaceId", "phone");
CREATE INDEX "CourierFraudCheck_workspaceId_updatedAt_idx" ON "CourierFraudCheck"("workspaceId", "updatedAt");

ALTER TABLE "CourierFraudCheck" ADD CONSTRAINT "CourierFraudCheck_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
