-- The delivery phone on an order, in the same shape as every other number here.
--
-- A customer's number is normalized to 01XXXXXXXXX on the way in, but the
-- parcel phone was stored exactly as typed — so "+880 1712-345678" and
-- "01712 345678" sit in this column as themselves, and searching the order list
-- by a number could not reach them. Reshaping the stored rows once is what lets
-- one search find every order for a number (see lib/phone, shipSnapshot).
--
-- Deliberately conservative: only values that read as a number are touched, so
-- anything somebody typed as a note in that field is left exactly as it is.
-- Idempotent — a second run finds nothing left to change.
WITH shaped AS (
  SELECT
    "id",
    regexp_replace("shipPhone", '[^0-9]', '', 'g') AS digits
  FROM "Order"
  WHERE "shipPhone" IS NOT NULL
    AND "shipPhone" ~ '^[0-9+()./ -]+$'
),
normalized AS (
  SELECT
    "id",
    CASE
      -- +8801712345678 / 8801712345678 -> 01712345678
      WHEN length(digits) = 13 AND digits LIKE '880%' THEN substring(digits FROM 3)
      -- 88 + 1XXXXXXXXX, the leading zero never typed
      WHEN length(digits) = 12 AND digits LIKE '88%' THEN '0' || substring(digits FROM 3)
      -- 1712345678 — the leading zero dropped, which forms do constantly
      WHEN length(digits) = 10 AND digits LIKE '1%' THEN '0' || digits
      -- Not recognisably a Bangladeshi mobile: keep the digits rather than
      -- reshape it into something that looks valid but isn't.
      ELSE digits
    END AS phone
  FROM shaped
  WHERE digits <> ''
)
UPDATE "Order" o
SET "shipPhone" = n.phone
FROM normalized n
WHERE o."id" = n."id"
  AND o."shipPhone" <> n.phone;

-- A snapshot that now says the same thing as the customer record is dropped, as
-- a fresh order would store it: null means "read the customer", which keeps a
-- corrected number reaching this order's invoice and parcel slip instead of
-- freezing a duplicate of it here.
UPDATE "Order" o
SET "shipPhone" = NULL
FROM "Customer" c
WHERE o."customerId" = c."id"
  AND o."shipPhone" IS NOT NULL
  AND c."phone" IS NOT NULL
  AND o."shipPhone" = c."phone";
