import { prisma } from "@/lib/prisma";
import { districtFromIso } from "@/lib/bd-locations";
import { clearAbandonedCartFor } from "@/lib/abandoned-cart-store";

/**
 * Turning a WooCommerce order into a call-list lead.
 *
 * Shared by the webhook (/api/cron/woo-lead) and the pull-based sync, because
 * the two must agree exactly: a webhook-delivered order and the same order
 * seen by the sync have to produce the same row, or re-syncing would rewrite
 * fields with subtly different values.
 */

export const WOO_SOURCE = "WOOCOMMERCE";

export type WooLineItem = {
  /** The catalogue product this line sold — how a combo is recognised again. */
  product_id?: number;
  name?: string;
  quantity?: number;
  meta_data?: { key?: string; display_value?: string }[];
};

export type WooOrder = {
  id?: number;
  number?: string;
  status?: string;
  date_created?: string;
  date_created_gmt?: string;
  total?: string;
  billing?: Record<string, string | undefined>;
  shipping?: Record<string, string | undefined>;
  line_items?: WooLineItem[];
};

const join = (...parts: (string | undefined)[]) => parts.filter((p) => p && p.trim()).join(", ");

function addressOf(o: WooOrder) {
  // Shipping is what actually gets delivered to; fall back to billing, which
  // is all a Store API checkout fills in when shipping is left blank.
  const s = o.shipping ?? {};
  const b = o.billing ?? {};
  const pick = (k: string) => (s[k]?.trim() ? s[k] : b[k]);
  const city = pick("city")?.trim();
  // `state` is not a district name: the checkout's select stores an ISO
  // 3166-2:BD code, so every website address ended in "BD-13" — a line that
  // means nothing to whoever makes the call and nothing to the courier who
  // prints it. The customer did pick a district; this is what they picked.
  const district = districtFromIso(pick("state"));
  return (
    join(
      pick("address_1"),
      pick("address_2"),
      city,
      // "Cumilla, Cumilla" when the town somebody typed is the district itself.
      district && district.toLowerCase() === (city ?? "").toLowerCase()
        ? undefined
        : (district ?? undefined),
    ) || null
  );
}

function orderedAtOf(o: WooOrder) {
  // WooCommerce sends these without a timezone suffix, which new Date() would
  // read as the *server's* local time — six hours off here, enough to date a
  // morning order to the previous day. _gmt is unambiguous once marked as UTC,
  // and stays right even if the site's timezone changes.
  const gmt = o.date_created_gmt;
  if (gmt) return new Date(gmt.endsWith("Z") ? gmt : `${gmt}Z`);
  if (o.date_created) return new Date(o.date_created);
  return new Date();
}

function itemsTextOf(o: WooOrder) {
  return (o.line_items ?? [])
    .map((li) => {
      // Underscore keys are WooCommerce's internal bookkeeping (_reduced_stock
      // and friends) — including them printed a stray "(1)" after every item.
      const variation = (li.meta_data ?? [])
        .filter((m) => m.key && !m.key.startsWith("_"))
        .map((m) => m.display_value)
        .filter(Boolean)
        .join(" / ");
      return `${li.name ?? "Item"}${variation ? ` (${variation})` : ""} x${li.quantity ?? 1}`;
    })
    .join(", ");
}

/** The order-derived half of a lead. Call-tracking fields are never in here. */
export function leadFieldsFrom(order: WooOrder, rawPayload: unknown) {
  const b = order.billing ?? {};
  const s = order.shipping ?? {};
  const name =
    join(s.first_name, s.last_name).replace(", ", " ").trim() ||
    join(b.first_name, b.last_name).replace(", ", " ").trim() ||
    "Unknown";

  return {
    orderNo: order.number ? `#${order.number}` : null,
    // "checkout-draft" = the customer pressed Place order and it did not go
    // through. Not "never pressed it", which this comment said for a long time
    // and which the storefront makes impossible: the draft carries
    // `payment_method: cod` and the synthetic `order.<digits>@gedushop.com`
    // address, and both are built inside CheckoutForm's submit handler and
    // sent only in the POST that places the order. Every draft on the store
    // also carries a resolved shipping line and a full address — they are
    // finished orders that never flipped to processing.
    //
    // Worth calling for exactly that reason, and worth watching: of the eleven
    // on record to 2026-09-03, not one of those customers ever came back and
    // ordered. WooCommerce fires no webhook for these, so they only ever
    // arrive through the sync.
    wooStatus: order.status ?? null,
    customerName: name,
    // Never drop an order for a missing phone — an empty cell is still callable
    // information ("no number given"), a 400 back to WooCommerce is not.
    phone: (b.phone ?? s.phone ?? "").trim(),
    address: addressOf(order),
    itemsText: itemsTextOf(order),
    total: order.total ? Number(order.total) : 0,
    orderedAt: orderedAtOf(order),
    rawPayload: rawPayload as never,
  };
}

/**
 * Create or refresh the lead for a WooCommerce order.
 *
 * The update deliberately writes only order-derived fields: call status,
 * attempts, who called, the customer's advice and the linked customer all
 * survive, so a re-sync or an order.updated re-fire can never undo the work of
 * whoever made the call.
 */
export async function upsertLeadFromWooOrder(
  workspaceId: string,
  order: WooOrder,
  rawPayload: unknown,
) {
  const fields = leadFieldsFrom(order, rawPayload);
  const lead = await prisma.orderLead.upsert({
    where: {
      workspaceId_source_externalId: {
        workspaceId,
        source: WOO_SOURCE,
        externalId: String(order.id),
      },
    },
    // `channel` is set on create only. `update` runs on every webhook and on
    // every page-open pull, so including it there would wipe out a channel
    // someone had corrected by hand each time the order was touched.
    create: {
      workspaceId,
      source: WOO_SOURCE,
      externalId: String(order.id),
      channel: "WEBSITE",
      ...fields,
    },
    update: fields,
  });

  // This person reached the checkout, so the storefront's beacon will have
  // filed them as an abandoned cart while they were typing. They finished —
  // drop that row, or the call list shows "they left this behind" beside the
  // order they actually placed. A checkout-draft is left alone on purpose:
  // that one really did fail.
  if (order.status !== "checkout-draft") {
    await clearAbandonedCartFor(workspaceId, fields.phone);
  }

  return lead;
}

/**
 * What a website order bought, as catalogue product ids.
 *
 * The one thing a lead keeps that a person cannot retype reliably. `itemsText`
 * is written to be read down a phone line — "Flight Starter Combo x1" — and
 * matching that back to a catalogue variant by name is exactly the guess the
 * order form has always refused to make. The raw payload still carries the
 * product ids WooCommerce sold under, and a combo is identified by its own id
 * on both sides (see ComboSet.wooProductId), so a combo — and only a combo —
 * can be put back together exactly.
 *
 * Returns every line, not only the combos: which of these ids IS a combo is a
 * question for whoever holds the recipes, and this function has no database.
 * Quantities are summed, so the same product on two lines counts once.
 */
export function wooLineProductIds(rawPayload: unknown): { productId: number; quantity: number }[] {
  const items = (rawPayload as WooOrder | null)?.line_items;
  if (!Array.isArray(items)) return [];
  const totals = new Map<number, number>();
  for (const li of items) {
    const id = Number(li?.product_id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const qty = Math.max(1, Math.trunc(Number(li?.quantity) || 1));
    totals.set(id, (totals.get(id) ?? 0) + qty);
  }
  return [...totals].map(([productId, quantity]) => ({ productId, quantity }));
}

/** Statuses that need no phone call, so pulling them in would only be noise. */
const SKIP_STATUSES = new Set(["cancelled", "refunded", "failed", "trash"]);

export function wooConfigured() {
  return Boolean(process.env.WC_CONSUMER_KEY && process.env.WC_CONSUMER_SECRET);
}

/**
 * Pull recent orders from WooCommerce and upsert them.
 *
 * The webhook covers real orders, but WooCommerce never fires one for a
 * checkout-draft — an abandoned checkout that still carries a name, phone,
 * address and cart. Those can only be found by asking.
 */
export async function syncWooOrders(
  workspaceId: string,
  { pages = 1, perPage = 50 }: { pages?: number; perPage?: number } = {},
): Promise<{ seen: number; upserted: number; skipped: number }> {
  const base = (process.env.WP_URL || "https://wp.gedushop.com").replace(/\/$/, "");
  const auth =
    "Basic " +
    Buffer.from(`${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`).toString(
      "base64",
    );

  let seen = 0;
  let upserted = 0;
  let skipped = 0;

  for (let page = 1; page <= pages; page++) {
    const url = `${base}/wp-json/wc/v3/orders?per_page=${perPage}&page=${page}&status=any&orderby=date&order=desc`;
    const res = await fetch(url, { headers: { Authorization: auth }, cache: "no-store" });
    if (!res.ok) {
      throw new Error(`WooCommerce returned ${res.status}`);
    }
    const orders = (await res.json()) as WooOrder[];
    if (!orders.length) break;

    for (const order of orders) {
      seen++;
      if (!order.id || SKIP_STATUSES.has(String(order.status))) {
        skipped++;
        continue;
      }
      await upsertLeadFromWooOrder(workspaceId, order, order);
      upserted++;
    }

    if (orders.length < perPage) break;
  }

  return { seen, upserted, skipped };
}
