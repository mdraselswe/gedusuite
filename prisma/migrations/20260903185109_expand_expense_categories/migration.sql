-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExpenseCategory" ADD VALUE 'FACEBOOK_ADS';
ALTER TYPE "ExpenseCategory" ADD VALUE 'ONLINE_ADVERTISING';
ALTER TYPE "ExpenseCategory" ADD VALUE 'WEBSITE_HOSTING';
ALTER TYPE "ExpenseCategory" ADD VALUE 'AI_SUBSCRIPTION';
ALTER TYPE "ExpenseCategory" ADD VALUE 'SOFTWARE_SUBSCRIPTION';
ALTER TYPE "ExpenseCategory" ADD VALUE 'MOBILE_BILL';
ALTER TYPE "ExpenseCategory" ADD VALUE 'INTERNET_BILL';
ALTER TYPE "ExpenseCategory" ADD VALUE 'VEHICLE_RENT';
ALTER TYPE "ExpenseCategory" ADD VALUE 'FUEL';
ALTER TYPE "ExpenseCategory" ADD VALUE 'FOOD_REFRESHMENT';
ALTER TYPE "ExpenseCategory" ADD VALUE 'RENT';
ALTER TYPE "ExpenseCategory" ADD VALUE 'SALARY_WAGES';
ALTER TYPE "ExpenseCategory" ADD VALUE 'BANK_PAYMENT_FEES';
ALTER TYPE "ExpenseCategory" ADD VALUE 'PROFESSIONAL_FEES';
ALTER TYPE "ExpenseCategory" ADD VALUE 'REPAIR_MAINTENANCE';

-- DropIndex
DROP INDEX "Order_courierId_idx";
