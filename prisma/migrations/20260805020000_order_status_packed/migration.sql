-- "Packed and waiting for the courier" had no way to be recorded: an order
-- jumped from CONFIRMED straight to SHIPPED, so the day or two a parcel sits
-- on the table was invisible.
--
-- Alone in its own migration on purpose. Postgres will not let a value added
-- to an enum be USED in the same transaction that adds it, and Prisma runs
-- each migration inside one — so anything referencing 'PACKED' has to wait
-- for a later migration.

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'PACKED' AFTER 'CONFIRMED';
