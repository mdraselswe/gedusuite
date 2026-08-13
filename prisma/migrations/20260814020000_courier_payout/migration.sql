-- A payout the courier has made, as the courier itself records it.
--
-- The one fact the app could never derive: which parcels a payment covered and
-- what it actually paid. Everything else on this page comes from the orders,
-- and derived was close but never exact — the percentage fee is charged on the
-- payout as a whole and floored to a whole taka, so summing the orders' own
-- figures lands a quarter taka out on a good day, and 1.35 out on a set that
-- contains a return.
--
-- The unique key on (courierId, externalId) is what makes importing twice a
-- no-op, which matters because the import is a button somebody will press
-- again when they are not sure it worked the first time.
CREATE TABLE "CourierPayout" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "deliveryBills" DECIMAL(12,2) NOT NULL,
    "charges" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "method" TEXT,
    "paidAt" TIMESTAMP(3),
    "consignmentIds" JSONB NOT NULL,
    "ordersTotal" DECIMAL(12,2) NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierPayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierPayout_courierId_externalId_key" ON "CourierPayout"("courierId", "externalId");
CREATE INDEX "CourierPayout_workspaceId_idx" ON "CourierPayout"("workspaceId");

ALTER TABLE "CourierPayout" ADD CONSTRAINT "CourierPayout_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourierPayout" ADD CONSTRAINT "CourierPayout_courierId_fkey"
    FOREIGN KEY ("courierId") REFERENCES "Courier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
