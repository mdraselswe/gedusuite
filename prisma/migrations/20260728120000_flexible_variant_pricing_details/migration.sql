-- Flexible product variants: replace fixed size/color with a JSON `attributes`
-- combination, add per-variant pricing (salePrice, unitCost) and details
-- (barcode, imageUrl, lowStockThreshold override, description), and record the
-- ordered attribute-name list on each Product. Legacy size/color values are
-- backfilled into `attributes` before the old columns are dropped.

BEGIN;

-- Product: ordered attribute-name list, e.g. ["Size","Color"]
ALTER TABLE "Product" ADD COLUMN "attributeNames" JSONB NOT NULL DEFAULT '[]';

-- ProductVariant: flexible attributes + per-variant pricing & details
ALTER TABLE "ProductVariant" ADD COLUMN "attributes" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "ProductVariant" ADD COLUMN "salePrice" DECIMAL(12,2);
ALTER TABLE "ProductVariant" ADD COLUMN "unitCost" DECIMAL(12,2);
ALTER TABLE "ProductVariant" ADD COLUMN "barcode" TEXT;
ALTER TABLE "ProductVariant" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "ProductVariant" ADD COLUMN "lowStockThreshold" INTEGER;
ALTER TABLE "ProductVariant" ADD COLUMN "description" TEXT;

-- Backfill: legacy size/color -> attributes array
UPDATE "ProductVariant" SET "attributes" =
    (CASE WHEN "size" IS NOT NULL AND "size" <> ''
          THEN jsonb_build_array(jsonb_build_object('name', 'Size', 'value', "size"))
          ELSE '[]'::jsonb END)
  ||
    (CASE WHEN "color" IS NOT NULL AND "color" <> ''
          THEN jsonb_build_array(jsonb_build_object('name', 'Color', 'value', "color"))
          ELSE '[]'::jsonb END);

-- Backfill: Product.attributeNames from the legacy fields its variants used
UPDATE "Product" p SET "attributeNames" = sub.names
FROM (
  SELECT "productId",
      (CASE WHEN bool_or("size" IS NOT NULL AND "size" <> '')
            THEN jsonb_build_array('Size') ELSE '[]'::jsonb END)
    ||
      (CASE WHEN bool_or("color" IS NOT NULL AND "color" <> '')
            THEN jsonb_build_array('Color') ELSE '[]'::jsonb END) AS names
  FROM "ProductVariant"
  GROUP BY "productId"
) sub
WHERE p.id = sub."productId";

-- Drop legacy columns (values now live in ProductVariant.attributes)
ALTER TABLE "ProductVariant" DROP COLUMN "size";
ALTER TABLE "ProductVariant" DROP COLUMN "color";

COMMIT;
