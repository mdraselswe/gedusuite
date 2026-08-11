-- Booking parcels through the courier's API instead of retyping them into its app.

-- A short per-workspace order number. The cuid is the right primary key and
-- the wrong thing to say out loud or match against a courier's statement;
-- Steadfast wants a unique `invoice` per parcel and displays it in its app.
ALTER TABLE "Order" ADD COLUMN "orderNo" INTEGER;

-- Backfill in the order the shop actually took them, so #1 is the first sale
-- and not whichever row Postgres happened to return first. date is the
-- business day; createdAt then id break ties deterministically.
WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY "workspaceId"
           ORDER BY "date", "createdAt", "id"
         ) AS n
  FROM "Order"
)
UPDATE "Order" o
SET "orderNo" = numbered.n
FROM numbered
WHERE o.id = numbered.id;

CREATE UNIQUE INDEX "Order_workspaceId_orderNo_key" ON "Order"("workspaceId", "orderNo");

-- Which district the address appears to name, tagged at booking time. For
-- reports only — it is not sent to the courier and never gates a parcel.
ALTER TABLE "Order" ADD COLUMN "shipDistrict" TEXT;

-- Steadfast returns a consignment id (already stored in courierTrackingId) and
-- a separate tracking code; its app searches by either.
ALTER TABLE "Order" ADD COLUMN "courierTrackingCode" TEXT;

-- What the courier last said, kept apart from the order's own status because
-- applying a cancellation needs figures a webhook cannot know.
ALTER TABLE "Order" ADD COLUMN "courierStatus" TEXT;
ALTER TABLE "Order" ADD COLUMN "courierStatusAt" TIMESTAMP(3);

-- Claimed the moment a booking starts, cleared if it fails. Without it, the
-- seconds a courier takes to answer are seconds in which a second click books
-- the same parcel again.
ALTER TABLE "Order" ADD COLUMN "courierBookingAt" TIMESTAMP(3);

-- Per-workspace courier API credentials, AES-256-GCM encrypted by lib/crypto.
-- Not environment variables: every workspace books through its own account.
ALTER TABLE "Courier" ADD COLUMN "apiProvider" TEXT;
ALTER TABLE "Courier" ADD COLUMN "apiKeyEnc" TEXT;
ALTER TABLE "Courier" ADD COLUMN "apiSecretEnc" TEXT;

-- Random path segment on this workspace's webhook URL. /api/cron is public, so
-- this token is what stands between the open internet and a status write.
ALTER TABLE "Courier" ADD COLUMN "webhookToken" TEXT;
CREATE UNIQUE INDEX "Courier_webhookToken_key" ON "Courier"("webhookToken");
