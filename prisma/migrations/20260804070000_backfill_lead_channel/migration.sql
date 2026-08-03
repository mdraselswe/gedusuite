-- Leads pulled from WooCommerce came through the website by definition — the
-- row only exists because an order was placed there — so tagging them is
-- recording what is already known, not guessing.
--
-- MANUAL leads are deliberately left null: somebody typed those in from a
-- phone call, a Facebook comment or a WhatsApp message, and which one is not
-- recoverable from the data. They stay "Not set" until a human says.
--
-- Guarded on IS NULL so it never overwrites a channel someone has since
-- corrected by hand, and so re-running it is a no-op.

UPDATE "OrderLead"
SET "channel" = 'WEBSITE'
WHERE "source" = 'WOOCOMMERCE' AND "channel" IS NULL;
