/**
 * One-off backfill: pull existing WooCommerce orders into the call list.
 *
 * Deliberately does NOT talk to Prisma. It signs each order the way
 * WooCommerce would and POSTs it to the real webhook route, so a backfilled
 * order and a live one go through exactly the same parsing and upsert — there
 * is no second copy of the mapping to drift out of sync. It is also idempotent
 * for the same reason: the route upserts on (workspace, source, order id) and
 * never overwrites call-tracking fields.
 *
 * Usage (creds come from the two projects' own .env.local files):
 *   node --env-file=../gedushop-frontend/.env.local --env-file=.env.local \
 *        scripts/backfill-woo-leads.mjs [targetUrl] [--dry]
 */
import { createHmac } from "node:crypto";

const TARGET = process.argv[2]?.startsWith("http")
  ? process.argv[2]
  : "http://localhost:3100/api/cron/woo-lead";
const DRY = process.argv.includes("--dry");

// Orders in these states need no phone call, so they'd only be noise.
const SKIP_STATUSES = new Set(["cancelled", "refunded", "failed", "trash"]);

const WP = (process.env.WP_URL || "https://wp.gedushop.com").replace(/\/$/, "");
const secret = process.env.WOO_WEBHOOK_SECRET;
if (!secret) {
  console.error("WOO_WEBHOOK_SECRET is not set — it must match the webhook's secret.");
  process.exit(1);
}
const auth =
  "Basic " +
  Buffer.from(`${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`).toString(
    "base64",
  );

let imported = 0;
let skipped = 0;
let failed = 0;

for (let page = 1; ; page++) {
  const url = `${WP}/wp-json/wc/v3/orders?per_page=100&page=${page}&status=any&orderby=date&order=asc`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) {
    console.error(`WooCommerce returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const orders = await res.json();
  if (!orders.length) break;

  for (const order of orders) {
    const tag = `#${order.number} ${String(order.status).padEnd(14)}`;
    if (SKIP_STATUSES.has(order.status)) {
      console.log(`${tag} skipped (${order.status})`);
      skipped++;
      continue;
    }
    if (DRY) {
      console.log(`${tag} would import`);
      imported++;
      continue;
    }

    const raw = JSON.stringify(order);
    const sig = createHmac("sha256", secret).update(raw, "utf8").digest("base64");
    const post = await fetch(TARGET, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wc-webhook-signature": sig },
      body: raw,
    });
    if (post.ok) {
      console.log(`${tag} imported`);
      imported++;
    } else {
      console.log(`${tag} FAILED ${post.status} ${(await post.text()).slice(0, 120)}`);
      failed++;
    }
  }

  if (orders.length < 100) break;
}

console.log(`\nimported ${imported} · skipped ${skipped} · failed ${failed}`);
if (failed) process.exit(1);
