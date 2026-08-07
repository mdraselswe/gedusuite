import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { variantSuffix } from "@/lib/variants";

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
 * Current stock per variant = purchased − sold(consuming orders) + returned.
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
        order: { workspaceId, status: { in: [...STOCK_CONSUMING_STATUSES] } },
        ...idFilter,
      },
      _sum: { quantity: true },
    }),
    // Product-linked gifts leave with the order just like sold items.
    client.orderGift.groupBy({
      by: ["productVariantId"],
      where: {
        order: { workspaceId, status: { in: [...STOCK_CONSUMING_STATUSES] } },
        productVariantId: variantIds ? { in: variantIds } : { not: null },
      },
      _sum: { quantity: true },
    }),
    client.return.findMany({
      // Only count returns whose order actually consumed stock. If the order was
      // cancelled, its stock is already restored via the sold total, so counting
      // the return too would add phantom stock.
      where: {
        workspaceId,
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
  const [stock, variants, corrections] = await Promise.all([
    variantStockMap(workspaceId),
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
  for (const v of variants) {
    const onHand = Math.max(0, stock.get(v.id) ?? 0);
    if (onHand === 0) continue;
    const unitCost = v.purchases[0]
      ? Number(v.purchases[0].unitCost)
      : v.unitCost != null
        ? Number(v.unitCost)
        : 0;
    units += onHand;
    value += onHand * unitCost;
    // Capped at what's actually on the shelf: pieces added by hand and since
    // sold aren't sitting in the value any more.
    fromCorrections += Math.min(onHand, addedByHand.get(v.id) ?? 0) * unitCost;
  }
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  return { units, value: round2(value), fromCorrections: round2(fromCorrections) };
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
