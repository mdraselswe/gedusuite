-- Mark customers who are worth reaching again for future product campaigns.
ALTER TABLE "Customer"
  ADD COLUMN "reengageEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reengageNote" TEXT,
  ADD COLUMN "reengageLastReachedAt" TIMESTAMP(3),
  ADD COLUMN "reengageNextReachAt" TIMESTAMP(3);

CREATE INDEX "Customer_workspaceId_reengageEnabled_reengageNextReachAt_idx"
  ON "Customer"("workspaceId", "reengageEnabled", "reengageNextReachAt");
