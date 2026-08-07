-- Stock and supplies taken on credit.
--
-- A purchase could say a partner paid for it, or the treasury did, or nothing
-- at all — and "nothing at all" was read as a partner having paid and not said
-- so, which is the right guess for a forgotten tag and completely wrong for
-- goods bought on terms. 50,000 of stock taken on account therefore showed up
-- as 50,000 of partner capital consumed, and the 50,000 still owed to the
-- supplier appeared nowhere in the app at all. Partners could look at that
-- screen and distribute money the shop needed to pay its supplier with.
--
-- A fourth, mutually exclusive funding state. Paying the bill later is the
-- existing edit: switch the row from Credit to Treasury or Partner and the
-- treasury deduction / partner credit gets written exactly as it would have
-- been at the time.
--
-- Defaults to false, so every existing row keeps the funding it already had.
ALTER TABLE "Purchase" ADD COLUMN "onCredit" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "InternalPurchase" ADD COLUMN "onCredit" BOOLEAN NOT NULL DEFAULT false;
