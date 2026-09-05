import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { variantSuffix } from "@/lib/variants";
import { loadFlexibleComboVariants } from "@/lib/combo-variants";
import { recipeBuildable, withProductVariants } from "@/lib/flexible-combos";
import { round2 } from "@/lib/money";

/** Enough of a Prisma client to derive stock — the real one or a transaction. */
type StockClient = Pick<
  Prisma.TransactionClient,
  "purchase" | "orderItem" | "orderGift" | "return" | "stockAdjustment"
>;

/** Raised inside a transaction when a variant can't cover what's being sold. */
export class OutOfStock extends Error {
  constructor(label: string) {
    super(`Not enough stock — ${label} sold out while this order was being saved`);
    this.name = "OutOfStock";
  }
}

export const EXPIRY_WINDOW_DAYS = 30;

// Orders in these statuses have consumed their stock. PENDING/CANCELLED have not,
// so cancelling an order automatically restores stock (no column mutation needed).
// PACKED sits between CONFIRMED and SHIPPED: the goods are in the box, so they
// are as gone from the shelf as a shipped order's.
export const STOCK_CONSUMING_STATUSES = [
  "CONFIRMED",
  "PACKED",
  "SHIPPED",
  "DELIVERED",
] as const;

/**
 * An order whose units are not on the shelf right now.
 *
 * Two different reasons, one consequence. A consuming order has them because
 * it sold them. A cancelled order has them because they are in the back of a
 * courier's van somewhere between the customer's door and the return hub —
 * the sale is off, the money is settled, and the pieces are still days away.
 *
 * Cancelling used to mean both at once, and the second half was wrong for as
 * long as the return leg took: the app offered stock nobody had, and a parcel
 * the courier lost stayed on the shelf forever because nothing ever said it
 * had not arrived. Everything that asks "how many can I sell" goes through
 * here, so both cases answer the same way.
 */
export function offShelfOrderWhere(workspaceId?: string) {
  return {
    ...(workspaceId ? { workspaceId } : {}),
    OR: [
      { status: { in: [...STOCK_CONSUMING_STATUSES] } },
      { status: "CANCELLED" as const, returnLeg: "IN_TRANSIT" as const },
    ],
  };
}

/**
 * Current stock per variant = purchased − off the shelf + returned (once the
 * returned goods are actually here) + adjustments.
 * Stock is always derived, never stored, so it can't drift out of sync.
 */
export async function variantStockMap(
  workspaceId: string,
  // When given, only these variants' stock is computed — used by the async
  // product search so we don't aggregate every variant in the workspace just
  // to show one page of results.
  variantIds?: string[],
  // Pass a transaction when the answer is about to be acted on. Stock is
  // derived rather than stored, so nothing at the database level stops two
  // orders claiming the same last piece; reading it inside the transaction
  // that writes the order is what closes that gap.
  client: StockClient = prisma,
): Promise<Map<string, number>> {
  const idFilter = variantIds ? { productVariantId: { in: variantIds } } : {};
  const [purchased, sold, gifted, returns, adjustments] = await Promise.all([
    client.purchase.groupBy({
      by: ["productVariantId"],
      where: { workspaceId, ...idFilter },
      _sum: { quantity: true },
    }),
    client.orderItem.groupBy({
      by: ["productVariantId"],
      where: {
        order: offShelfOrderWhere(workspaceId),
        ...idFilter,
      },
      _sum: { quantity: true },
    }),
    // Product-linked gifts leave with the order just like sold items — and
    // come back in the same parcel when it is refused.
    client.orderGift.groupBy({
      by: ["productVariantId"],
      where: {
        order: offShelfOrderWhere(workspaceId),
        productVariantId: variantIds ? { in: variantIds } : { not: null },
      },
      _sum: { quantity: true },
    }),
    client.return.findMany({
      // Only count returns whose order actually consumed stock. If the order was
      // cancelled, its stock is already restored via the sold total, so counting
      // the return too would add phantom stock.
      //
      // And only once the goods are actually here. A return recorded the day
      // the customer posts it is the same lie a cancellation was: agreed on
      // the phone, on the shelf a week early.
      where: {
        workspaceId,
        receivedAt: { not: null },
        orderItem: {
          order: { status: { in: [...STOCK_CONSUMING_STATUSES] } },
          ...(variantIds ? { productVariantId: { in: variantIds } } : {}),
        },
      },
      select: { quantity: true, orderItem: { select: { productVariantId: true } } },
    }),
    client.stockAdjustment.groupBy({
      by: ["productVariantId"],
      where: { workspaceId, ...idFilter },
      _sum: { delta: true },
    }),
  ]);

  const map = new Map<string, number>();
  for (const r of purchased) map.set(r.productVariantId, r._sum.quantity ?? 0);
  for (const r of sold) {
    map.set(r.productVariantId, (map.get(r.productVariantId) ?? 0) - (r._sum.quantity ?? 0));
  }
  for (const r of gifted) {
    if (!r.productVariantId) continue;
    map.set(r.productVariantId, (map.get(r.productVariantId) ?? 0) - (r._sum.quantity ?? 0));
  }
  for (const r of returns) {
    const vid = r.orderItem.productVariantId;
    map.set(vid, (map.get(vid) ?? 0) + r.quantity);
  }
  // Manual adjustments: signed delta (damaged/lost/gift negative, correction either way).
  for (const r of adjustments) {
    map.set(r.productVariantId, (map.get(r.productVariantId) ?? 0) + (r._sum.delta ?? 0));
  }
  return map;
}

/**
 * Pieces per variant that are on their way back to the shop but not here yet:
 * cancelled parcels the courier is carrying, plus customer returns that have
 * been agreed and not yet arrived.
 *
 * Deliberately separate from `variantStockMap` rather than folded into it.
 * These pieces are not sellable — that is the whole point of holding them out
 * — but they are coming, and somebody looking at "0 in stock" needs to know
 * that four of them land on Thursday before they reorder from the supplier.
 */
export async function inTransitReturnMap(
  workspaceId: string,
  variantIds?: string[],
): Promise<Map<string, number>> {
  const idFilter = variantIds ? { productVariantId: { in: variantIds } } : {};
  const [cancelled, gifts, returns] = await Promise.all([
    prisma.orderItem.groupBy({
      by: ["productVariantId"],
      where: {
        order: { workspaceId, status: "CANCELLED", returnLeg: "IN_TRANSIT" },
        ...idFilter,
      },
      _sum: { quantity: true },
    }),
    prisma.orderGift.groupBy({
      by: ["productVariantId"],
      where: {
        order: { workspaceId, status: "CANCELLED", returnLeg: "IN_TRANSIT" },
        productVariantId: variantIds ? { in: variantIds } : { not: null },
      },
      _sum: { quantity: true },
    }),
    prisma.return.findMany({
      where: {
        workspaceId,
        receivedAt: null,
        orderItem: {
          order: { status: { in: [...STOCK_CONSUMING_STATUSES] } },
          ...(variantIds ? { productVariantId: { in: variantIds } } : {}),
        },
      },
      select: { quantity: true, orderItem: { select: { productVariantId: true } } },
    }),
  ]);

  const map = new Map<string, number>();
  const add = (vid: string, n: number) => map.set(vid, (map.get(vid) ?? 0) + n);
  for (const r of cancelled) add(r.productVariantId, r._sum.quantity ?? 0);
  for (const r of gifts) {
    if (r.productVariantId) add(r.productVariantId, r._sum.quantity ?? 0);
  }
  for (const r of returns) add(r.orderItem.productVariantId, r.quantity);
  return map;
}

/**
 * How many of each combo the shelf can actually make right now.
 *
 * Nothing stores this, and nothing should. A combo is a recipe over variants
 * that are also on sale individually, so the same piece backs the combo and
 * its own product listing at once; a stored combo count would be a second
 * copy of a number `variantStockMap` already holds, and it would be wrong the
 * first time either side sold. Derived here, selling the last aeroplane on its
 * own empties every combo containing one, and selling that combo empties the
 * aeroplane's own listing — with no bookkeeping in between.
 *
 * Pass the transaction when the answer is about to be acted on, for exactly
 * the reason `variantStockMap` gives.
 */
export async function comboStockMap(
  workspaceId: string,
  comboIds?: string[],
  client: StockClient & Pick<Prisma.TransactionClient, "comboSet" | "productVariant"> = prisma,
): Promise<Map<string, number>> {
  const combos = await client.comboSet.findMany({
    where: { workspaceId, ...(comboIds ? { id: { in: comboIds } } : {}) },
    select: { id: true, flexibleVariants: true, items: { select: { productVariantId: true, quantity: true, productVariant: { select: { productId: true } } } } },
  });
  if (combos.length === 0) return new Map();
  const siblings = await loadFlexibleComboVariants(workspaceId, combos, client);

  // One stock query for every component of every combo asked about, rather
  // than one per combo: a shop with twenty combos over forty variants would
  // otherwise run twenty aggregations of five tables each.
  const variantIds = [
    ...new Set([...combos.flatMap((c) => c.items.map((i) => i.productVariantId)), ...siblings.map((v) => v.productVariantId)]),
  ];
  const stock = await variantStockMap(workspaceId, variantIds, client);

  return new Map(combos.map((c) => [c.id, recipeBuildable(withProductVariants(c.items.map((i) => ({ ...i, productId: i.productVariant.productId, salePrice: null })), siblings, c.flexibleVariants), stock, c.flexibleVariants)]));
}

/**
 * What one piece of a variant cost: what it last cost to buy, then the
 * catalogue cost, then nothing.
 *
 * The one chain, because a sale's cost snapshot follows it and stock value has
 * to agree with COGS about the same piece. It was written out by hand in four
 * places, and one of them — the product detail page — had only the catalogue
 * half. Most variants have no catalogue cost at all, since the real figure is
 * typed on the purchase form, so that page valued 54 of this shop's 73 stocked
 * variants at zero and put the shelf at 5,020 while the capital rollup put it
 * at 31,996.
 */
export function variantCost(v: {
  unitCost: unknown;
  purchases: { unitCost: unknown }[];
}): number {
  if (v.purchases[0]) return Number(v.purchases[0].unitCost);
  return v.unitCost != null ? Number(v.unitCost) : 0;
}

/**
 * What one piece of this variant lists for when sold on its own.
 *
 * The catalogue price is the answer when there is one; otherwise the price it
 * last actually went out at. Written down once because a combo's whole pitch
 * is "these would cost you X separately", and X computed two different ways on
 * two different screens is worse than no X at all.
 *
 * Null means nobody has ever priced it — a caller showing "bought separately"
 * has to say so rather than quietly counting it as free.
 */
export function variantListPrice(v: {
  salePrice: unknown;
  purchases: { salePrice?: unknown }[];
}): number | null {
  if (v.salePrice != null) return Number(v.salePrice);
  const last = v.purchases[0]?.salePrice;
  return last != null ? Number(last) : null;
}

/**
 * `variantCost` for a set of variants, ready to multiply by stock.
 *
 * Deliberately not date-filtered: "what it last cost" means the last purchase
 * there has ever been, not the last one inside whatever range a report is
 * being run over. A March-only report does not make the shelf worth nothing.
 */
export async function variantCostMap(
  workspaceId: string,
  variantIds?: string[],
): Promise<Map<string, number>> {
  const variants = await prisma.productVariant.findMany({
    where: {
      ...(variantIds ? { id: { in: variantIds } } : { product: { workspaceId } }),
    },
    select: {
      id: true,
      unitCost: true,
      purchases: {
        where: { workspaceId },
        orderBy: { date: "desc" },
        take: 1,
        select: { unitCost: true },
      },
    },
  });
  return new Map(variants.map((v) => [v.id, variantCost(v)]));
}

export type InventoryValue = {
  /** Pieces on the shelf, across every variant. Negative stock is ignored. */
  units: number;
  /** What those pieces cost to buy. */
  value: number;
  /**
   * How much of that value arrived through a hand-entered positive CORRECTION
   * rather than a purchase — stock somebody said was there, that no money is
   * recorded as having bought.
   *
   * Usually honest (a miscount being fixed) and left in the total for exactly
   * that reason. Reported separately because it is also the one way to raise
   * "capital still the partners'" by typing, and a figure nobody can trace back
   * to a receipt should say so rather than blend in.
   */
  fromCorrections: number;
  /** Pieces travelling back to the shop — see inTransitReturnMap. */
  inTransitUnits: number;
  /**
   * What those pieces cost, at the same price the shelf is valued at.
   *
   * Held apart from `value` rather than left out of it. They are off the shelf
   * and can't be sold, so they have no business in a stock figure — but the
   * shop still owns them, and dropping them silently would make a week's worth
   * of cancellations read as capital that evaporated and then came back.
   */
  inTransitValue: number;
};

/**
 * What the unsold stock is worth, at what it cost.
 *
 * The capital rollup treats every purchase as spending, which is true of the
 * cash and false of the position: a shop that turned 250,000 of capital into
 * 250,000 of stock has not lost anything, but "Remaining capital" said it had.
 * This is the other side of that entry.
 *
 * Valued the same way a sale's cost snapshot is — last purchase price, then the
 * catalogue cost, then nothing — so stock value and COGS can't tell different
 * stories about the same variant. Negative stock (more sold than the purchase
 * records account for) contributes zero rather than a negative asset; the
 * paperwork is behind, and pretending it's a liability doesn't help anyone.
 */
export async function inventoryValue(workspaceId: string): Promise<InventoryValue> {
  const [stock, inTransit, variants, corrections] = await Promise.all([
    variantStockMap(workspaceId),
    inTransitReturnMap(workspaceId),
    prisma.productVariant.findMany({
      where: { product: { workspaceId } },
      select: {
        id: true,
        unitCost: true,
        purchases: {
          where: { workspaceId },
          orderBy: { date: "desc" },
          take: 1,
          select: { unitCost: true },
        },
      },
    }),
    // Only the ones that ADD stock. A negative correction takes value away and
    // needs no flagging — nobody inflates a balance by writing stock off.
    prisma.stockAdjustment.groupBy({
      by: ["productVariantId"],
      where: { workspaceId, type: "CORRECTION", delta: { gt: 0 } },
      _sum: { delta: true },
    }),
  ]);
  const addedByHand = new Map(
    corrections.map((c) => [c.productVariantId, c._sum.delta ?? 0]),
  );

  let units = 0;
  let value = 0;
  let fromCorrections = 0;
  let inTransitUnits = 0;
  let inTransitValue = 0;
  for (const v of variants) {
    const unitCost = variantCost(v);
    // Not folded into `onHand`: these are the shop's, but they are in a van.
    const coming = inTransit.get(v.id) ?? 0;
    if (coming > 0) {
      inTransitUnits += coming;
      inTransitValue += coming * unitCost;
    }
    const onHand = Math.max(0, stock.get(v.id) ?? 0);
    if (onHand === 0) continue;
    units += onHand;
    value += onHand * unitCost;
    // Capped at what's actually on the shelf: pieces added by hand and since
    // sold aren't sitting in the value any more.
    fromCorrections += Math.min(onHand, addedByHand.get(v.id) ?? 0) * unitCost;
  }
  return {
    units,
    value: round2(value),
    fromCorrections: round2(fromCorrections),
    inTransitUnits,
    inTransitValue: round2(inTransitValue),
  };
}

export type InventoryAlert = {
  type: "LOW_STOCK" | "EXPIRY";
  message: string;
  dedupeKey: string;
};

/**
 * Compute current low-stock and expiry-approaching alerts for a workspace.
 * Low stock: a stocked variant whose quantity <= its product threshold.
 * Expiry: a purchase lot with an expiry date within EXPIRY_WINDOW_DAYS (or past).
 */
export async function computeInventoryAlerts(
  workspaceId: string,
): Promise<InventoryAlert[]> {
  const alerts: InventoryAlert[] = [];

  const stock = await variantStockMap(workspaceId);

  const products = await prisma.product.findMany({
    where: { workspaceId },
    select: {
      name: true,
      lowStockThreshold: true,
      variants: { select: { id: true, attributes: true, lowStockThreshold: true } },
    },
  });

  for (const p of products) {
    for (const v of p.variants) {
      const qty = stock.get(v.id);
      // A variant may override the product-level threshold.
      const threshold = v.lowStockThreshold ?? p.lowStockThreshold;
      // Only flag variants that have ever been stocked and are now at/under threshold.
      if (qty !== undefined && qty <= threshold) {
        alerts.push({
          type: "LOW_STOCK",
          message: `Low stock: ${p.name}${variantSuffix(v.attributes)} — ${qty} left`,
          dedupeKey: `lowstock:${v.id}`,
        });
      }
    }
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + EXPIRY_WINDOW_DAYS);
  const expiring = await prisma.purchase.findMany({
    where: { workspaceId, expiryDate: { not: null, lte: cutoff } },
    select: {
      id: true,
      expiryDate: true,
      productVariantId: true,
      productVariant: {
        select: {
          attributes: true,
          product: { select: { name: true } },
        },
      },
    },
  });

  for (const pu of expiring) {
    // Nothing left of the variant means the lot is gone — sold, or written off
    // once it turned. Stock isn't tracked per lot, so this is the closest the
    // data can get to "that batch is no longer on the shelf", and it is the
    // difference between an alert that clears itself and one that sits in the
    // list for months after the goods went in the bin.
    if ((stock.get(pu.productVariantId) ?? 0) <= 0) continue;
    const label = pu.productVariant.product.name + variantSuffix(pu.productVariant.attributes);
    const d = pu.expiryDate!.toISOString().slice(0, 10);
    alerts.push({
      type: "EXPIRY",
      message: `Expiring: ${label} — expires ${d}`,
      dedupeKey: `expiry:${pu.id}`,
    });
  }

  return alerts;
}

/**
 * Recompute inventory alerts and reconcile Notification rows:
 * upsert current alerts, delete stale LOW_STOCK/EXPIRY notifications that no
 * longer apply. Returns the current alert list for immediate display.
 */
export async function refreshInventoryAlerts(
  workspaceId: string,
): Promise<InventoryAlert[]> {
  const [alerts, ws] = await Promise.all([
    computeInventoryAlerts(workspaceId),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
  ]);
  const liveKeys = new Set(alerts.map((a) => a.dedupeKey));
  const link = ws ? `/${ws.slug}/products` : null;

  await prisma.$transaction([
    ...alerts.map((a) =>
      prisma.notification.upsert({
        where: { workspaceId_dedupeKey: { workspaceId, dedupeKey: a.dedupeKey } },
        create: {
          workspaceId,
          type: a.type,
          message: a.message,
          link,
          dedupeKey: a.dedupeKey,
        },
        update: { message: a.message, type: a.type, link },
      }),
    ),
    // Clear resolved inventory alerts (stock replenished / lot consumed).
    prisma.notification.deleteMany({
      where: {
        workspaceId,
        type: { in: ["LOW_STOCK", "EXPIRY"] },
        dedupeKey: { notIn: liveKeys.size ? [...liveKeys] : ["__none__"] },
      },
    }),
  ]);

  return alerts;
}
