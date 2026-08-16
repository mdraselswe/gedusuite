-- Where a cancelled order's goods actually are.
--
-- Cancelling settled the money and put the pieces back on the shelf in the
-- same instant, which is true of the money and false of the goods: a refused
-- parcel spends days in the courier's return hub. In that window the app
-- offered stock nobody had, cleared its own low-stock alert so no reorder went
-- in, and — when a courier simply lost the parcel — went on offering it
-- forever, because nothing ever said the goods had not come back.
--
-- Existing rows are all NONE, which is what they should be: every cancellation
-- old enough to be in the table has long since been resolved one way or the
-- other, and back-dating them to IN_TRANSIT would take stock off the shelf
-- that is sitting on it.
CREATE TYPE "ReturnLeg" AS ENUM ('NONE', 'IN_TRANSIT', 'RECEIVED', 'LOST');

ALTER TABLE "Order" ADD COLUMN "returnLeg" "ReturnLeg" NOT NULL DEFAULT 'NONE';
ALTER TABLE "Order" ADD COLUMN "returnLegAt" TIMESTAMP(3);

-- Both readers — the pending-return list and the stock derivation's "still
-- travelling back" term — ask for one workspace's IN_TRANSIT rows.
CREATE INDEX "Order_workspaceId_returnLeg_idx" ON "Order"("workspaceId", "returnLeg");

-- The same gap on a customer's return: recorded the day they post it, on the
-- shelf a week before anyone can pack it. Null means "sent, not here yet".
ALTER TABLE "Return" ADD COLUMN "receivedAt" TIMESTAMP(3);

-- Every return that predates this was recorded when the goods arrived, so it
-- is received by definition. Left null they would each take their quantity
-- back off a shelf that has held it for months.
UPDATE "Return" SET "receivedAt" = "createdAt";
