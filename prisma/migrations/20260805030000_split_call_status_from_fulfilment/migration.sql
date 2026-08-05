-- The call list's one status column was answering two questions: how the
-- phone call went, and where the parcel got to. That forced isCallOutcome()
-- to special-case DELIVERED out of the attempt counter, and left no way to
-- say "confirmed on the phone but not packed yet".
--
-- Call outcomes stay here. Fulfilment now comes from the linked Order, so it
-- is recorded once, on the row that already tracks it.

-- A lead that was DELIVERED was, by definition, confirmed on the phone first.
-- The delivery itself belongs to the order, which this lead is not linked to
-- yet — so it's written to the internal note rather than dropped silently.
UPDATE "OrderLead"
SET "internalNote" = CASE
      WHEN "internalNote" IS NULL OR "internalNote" = ''
        THEN 'Was marked Delivered on the call list'
      ELSE "internalNote" || ' · Was marked Delivered on the call list'
    END,
    "callStatus" = 'CONFIRMED'
WHERE "callStatus" = 'DELIVERED';

-- AlterEnum: drop DELIVERED. Postgres has no DROP VALUE, so the type is
-- rebuilt — safe now that no row uses it.
ALTER TYPE "CallStatus" RENAME TO "CallStatus_old";

CREATE TYPE "CallStatus" AS ENUM ('NOT_CALLED', 'NO_ANSWER', 'PHONE_OFF', 'WRONG_NUMBER', 'CALL_LATER', 'CONFIRMED', 'CANCELLED');

ALTER TABLE "OrderLead" ALTER COLUMN "callStatus" DROP DEFAULT;
ALTER TABLE "OrderLead" ALTER COLUMN "callStatus" TYPE "CallStatus" USING ("callStatus"::text::"CallStatus");
ALTER TABLE "OrderLead" ALTER COLUMN "callStatus" SET DEFAULT 'NOT_CALLED';

DROP TYPE "CallStatus_old";

-- The order this lead became. Plain id, no foreign key: OrderLead
-- deliberately holds none, so that restoring a backup — which deletes every
-- order inside one transaction — can't be blocked by this table.
-- AlterTable
ALTER TABLE "OrderLead" ADD COLUMN     "orderId" TEXT;
