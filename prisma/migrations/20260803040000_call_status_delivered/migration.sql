-- AlterEnum
-- Placed after CONFIRMED so the dropdown reads in the order a call actually
-- progresses. ADD VALUE cannot run inside a transaction block on older
-- Postgres, but Prisma runs each statement of an enum-only migration on its
-- own, so a single statement here is safe.
ALTER TYPE "CallStatus" ADD VALUE 'DELIVERED' AFTER 'CONFIRMED';
