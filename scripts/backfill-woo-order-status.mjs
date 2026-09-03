/**
 * One-off backfill: push every already-settled order's outcome to the
 * website it came from.
 *
 * Delivered and cancelled orders have been going through gedusuite without
 * ever telling WooCommerce, so the website has shown "processing" on every
 * one of them regardless of what actually happened. This walks every
 * DELIVERED / CANCELLED order once and applies the same rules the live sync
 * uses from here on (src/lib/woo-order-sync.ts) — reimplemented here rather
 * than imported, the way every script in this folder talks to WooCommerce
 * itself instead of importing the Next app's TS modules.
 *
 * An order with no linked WooCommerce lead is skipped, not guessed at — see
 * that file for why. This run reports how many that was, so the count is
 * known rather than silently swallowed.
 *
 * Usage (creds come from this project's own .env.local):
 *   node --env-file=.env.local scripts/backfill-woo-order-status.mjs [--dry]
 */
import { PrismaClient } from "@prisma/client";

const DRY = process.argv.includes("--dry");
const prisma = new PrismaClient();

const WP = (process.env.WP_URL || "https://wp.gedushop.com").replace(/\/$/, "");
const KEY = process.env.WC_WRITE_KEY || process.env.WC_CONSUMER_KEY;
const SECRET = process.env.WC_WRITE_SECRET || process.env.WC_CONSUMER_SECRET;
if (!KEY || !SECRET) {
  console.error("WC_WRITE_KEY/SECRET (or WC_CONSUMER_KEY/SECRET) not set.");
  process.exit(1);
}
const AUTH = "Basic " + Buffer.from(`${KEY}:${SECRET}`).toString("base64");

const WOO_STATUS = { DELIVERED: "completed", CANCELLED: "cancelled" };
// Never downgrade a refund or an existing cancellation/completion typed on
// the website itself — see woo-order-sync.ts for the reasoning.
const WONT_OVERRIDE = {
  completed: ["refunded", "cancelled", "failed"],
  cancelled: ["refunded", "completed"],
};

async function wooGet(id) {
  const res = await fetch(`${WP}/wp-json/wc/v3/orders/${id}`, {
    headers: { Authorization: AUTH },
  });
  if (!res.ok) throw new Error(`GET ${id} -> ${res.status}`);
  return res.json();
}

async function wooPut(id, status) {
  const res = await fetch(`${WP}/wp-json/wc/v3/orders/${id}`, {
    method: "PUT",
    headers: { Authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`PUT ${id} -> ${res.status}: ${(await res.text()).slice(0, 150)}`);
}

const orders = await prisma.order.findMany({
  where: { status: { in: ["DELIVERED", "CANCELLED"] } },
  select: { id: true, orderNo: true, status: true },
  orderBy: { date: "asc" },
});

let pushed = 0;
let alreadyRight = 0;
let blocked = 0;
let unlinked = 0;
let failed = 0;
const unlinkedIds = [];

for (const order of orders) {
  const tag = `#${order.orderNo ?? order.id.slice(-6)} ${order.status.padEnd(9)}`;

  const lead = await prisma.orderLead.findFirst({
    where: { orderId: order.id, source: "WOOCOMMERCE" },
    select: { externalId: true },
  });
  const wooId = lead ? Number(lead.externalId) : null;
  if (!wooId || !Number.isFinite(wooId)) {
    unlinked++;
    unlinkedIds.push(order.orderNo ?? order.id);
    continue;
  }

  const target = WOO_STATUS[order.status];
  try {
    const current = await wooGet(wooId);
    if (current.status === target) {
      alreadyRight++;
      continue;
    }
    if (WONT_OVERRIDE[target]?.includes(current.status)) {
      console.log(`${tag} woo#${wooId} BLOCKED — website already says "${current.status}"`);
      blocked++;
      continue;
    }
    if (DRY) {
      console.log(`${tag} woo#${wooId} would set "${current.status}" -> "${target}"`);
    } else {
      await wooPut(wooId, target);
      console.log(`${tag} woo#${wooId} set "${current.status}" -> "${target}"`);
    }
    pushed++;
  } catch (e) {
    console.log(`${tag} woo#${wooId} FAILED — ${e.message}`);
    failed++;
  }

  // Polite to Hostinger — this is a burst of requests against the same
  // endpoint the storefront and every other script share.
  await new Promise((r) => setTimeout(r, 150));
}

console.log(
  `\n${DRY ? "[dry run] " : ""}${orders.length} settled orders — ` +
    `pushed ${pushed} · already right ${alreadyRight} · blocked ${blocked} · ` +
    `unlinked (skipped) ${unlinked} · failed ${failed}`,
);
if (unlinked) {
  console.log(`unlinked order numbers: ${unlinkedIds.join(", ")}`);
}

await prisma.$disconnect();
if (failed) process.exit(1);
