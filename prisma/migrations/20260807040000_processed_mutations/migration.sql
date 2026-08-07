-- Idempotency for the offline write queue.
--
-- submitOrQueue falls back to the outbox when the network drops mid-request —
-- including when the request actually reached the server and committed, and
-- only the response was lost. The replay then ran the same write a second
-- time, with nothing anywhere to notice: a 25,000 purchase saved on a flaky
-- connection became two purchase rows, two lots of stock, 50,000 out of the
-- treasury, and two INVESTMENT credits for the partner who paid once.
--
-- The client now generates a request id before its first attempt and reuses it
-- on every retry. The dispatcher inserts that id BEFORE calling the handler,
-- so the unique primary key is what rejects the duplicate — not a
-- read-then-check anyone could race.
--
-- No foreign key to Workspace on purpose: restoreSnapshot deletes rows inside
-- one transaction, and an FK from here would make every backup restore fail.
CREATE TABLE "ProcessedMutation" (
    "requestId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "actionType" TEXT NOT NULL,
    -- Null while the handler is still running; set once it returns.
    "ok" BOOLEAN,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedMutation_pkey" PRIMARY KEY ("requestId")
);

-- For pruning old rows; nothing reads them after the outbox has drained.
CREATE INDEX "ProcessedMutation_createdAt_idx" ON "ProcessedMutation"("createdAt");
