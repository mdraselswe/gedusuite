-- Rename, not drop+add: keep any budget values already entered.
ALTER TABLE "BoostAdSet" RENAME COLUMN "budget" TO "dailyBudget";
