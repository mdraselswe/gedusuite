import { prisma } from "@/lib/prisma";
import { cancelledOrderCost, computeOrderTotals } from "@/lib/orders";
import { variantStockMap } from "@/lib/inventory";
import { variantChip } from "@/lib/variants";
import type { DateRange } from "@/lib/reports";

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/**
 * Everything one product earned, cost and moved.
 *
 * The reports page answers this per product too, but only as gross margin —
 * (price − cost) × qty — which overstates what a product actually made,
 * sometimes badly: packaging, gifts, the courier's COD fee and the delivery
 * margin are all real money and all live on the ORDER, not the line. Here
 * those order-level amounts are allocated back to each line in proportion to
 * its share of the order's net revenue, so the per-product net profits of an
 * order sum to exactly the order's own net profit (computeOrderTotals).
 */

export type ProductVariantPerf = {
  variantId: string;
  label: string;
  sku: string | null;
  salePrice: number | null;
  unitCost: number | null;
  unitsSold: number;
  unitsReturned: number;
  revenue: number;
  cogs: number;
  grossMargin: number;
  netProfit: number;
  stock: number;
};

export type ProductOrderRow = {
  orderId: string;
  date: string;
  status: string;
  paymentStatus: string;
  customerId: string | null;
  customer: string | null;
  source: string | null;
  /** Variant labels of this product in that order. */
  variants: string[];
  units: number;
  returned: number;
  revenue: number;
  cogs: number;
  netProfit: number;
  /** Cancelled orders sell nothing; this is the share of the waste they carry. */
  cancelled: boolean;
  cancelledCost: number;
};

export type ProductPurchaseRow = {
  id: string;
  date: string;
  supplier: string | null;
  variant: string;
  quantity: number;
  unitCost: number;
  total: number;
  expiryDate: string | null;
};

export type ProductReturnRow = {
  id: string;
  date: string;
  orderId: string;
  variant: string;
  quantity: number;
  reason: string | null;
  refundAmount: number;
};

export type ProductAdjustmentRow = {
  id: string;
  date: string;
  variant: string;
  type: string;
  delta: number;
  reason: string | null;
};

export type ProductReport = {
  product: {
    id: string;
    name: string;
    category: string | null;
    sku: string | null;
    barcode: string | null;
    imageUrl: string | null;
    unitsPerPack: number | null;
    lowStockThreshold: number;
  };
  totals: {
    unitsSold: number;
    unitsReturned: number;
    orders: number;
    revenue: number;
    cogs: number;
    grossMargin: number;
    /** Allocated order-level amounts. Costs are positive numbers here. */
    packagingCost: number;
    giftCost: number;
    codFeeCost: number;
    /** Charged to the customer minus paid to the courier; can be negative. */
    deliveryMargin: number;
    netProfit: number;
    refunds: number;
    cancelledOrders: number;
    cancelledCost: number;
    netProfitAfterCancellations: number;
    avgSellPrice: number;
    avgUnitCost: number;
    /** Net profit ÷ revenue, as a percentage. Null when nothing sold. */
    marginPercent: number | null;
    /** Units of this product given away free with an order, and their cost. */
    giftedUnits: number;
    giftedCost: number;
  };
  stock: {
    onHand: number;
    /** On-hand pieces valued at each variant's catalogue unit cost. */
    value: number;
  };
  purchases: {
    quantity: number;
    spend: number;
    rows: ProductPurchaseRow[];
  };
  variants: ProductVariantPerf[];
  orders: ProductOrderRow[];
  returns: ProductReturnRow[];
  adjustments: ProductAdjustmentRow[];
  series: { date: string; units: number; revenue: number; profit: number }[];
};

/** One order line's own revenue, cost and share of the order's costs. */
export type AllocatedLine = {
  keptUnits: number;
  returnedUnits: number;
  /** Kept units × price, less this line's discount and its share of the order's. */
  revenue: number;
  cogs: number;
  /** This line's share of the order, 0–1. All lines of an order sum to 1. */
  share: number;
  packagingCost: number;
  giftCost: number;
  codFeeCost: number;
  /** Signed: positive when delivery was charged for more than it cost. */
  deliveryMargin: number;
  netProfit: number;
};

/** The minimum an order needs to be split into lines. */
type AllocatableOrder = Parameters<typeof computeOrderTotals>[0] & {
  items: ({ id: string } & Parameters<typeof computeOrderTotals>[0]["items"][number])[];
};

/**
 * Split an order's money across its lines, keyed by order-item id.
 *
 * Packaging, gifts, the COD fee and the delivery margin are charged to the
 * order as a whole, so they're allocated to each line in proportion to its
 * share of the order's net revenue. The allocation is exact: summing every
 * line's netProfit reproduces computeOrderTotals(order).netProfit, so a
 * product's profit and the order's can never tell different stories.
 */
export function allocateOrderLines(order: AllocatableOrder): Map<string, AllocatedLine> {
  const totals = computeOrderTotals(order);

  // Per-line net revenue on kept quantities, after the line's own discount.
  const lineNet = new Map<string, number>();
  const keptUnits = new Map<string, number>();
  let lineNetSum = 0;
  let keptUnitsSum = 0;
  for (const it of order.items) {
    const returned = it.returns.reduce((s, r) => s + r.quantity, 0);
    const eq = Math.max(0, it.quantity - returned);
    const fraction = it.quantity > 0 ? eq / it.quantity : 0;
    const net = Number(it.unitPrice) * eq - Number(it.discount) * fraction;
    lineNet.set(it.id, net);
    keptUnits.set(it.id, eq);
    lineNetSum += net;
    keptUnitsSum += eq;
  }

  const out = new Map<string, AllocatedLine>();
  for (const it of order.items) {
    const eq = keptUnits.get(it.id) ?? 0;
    const net = lineNet.get(it.id) ?? 0;
    // A fully-discounted or fully-returned order has no revenue to weight by,
    // so fall back to kept units and finally to an equal split — anything
    // beats silently dropping the order's costs on the floor.
    const share =
      lineNetSum > 0
        ? net / lineNetSum
        : keptUnitsSum > 0
          ? eq / keptUnitsSum
          : order.items.length > 0
            ? 1 / order.items.length
            : 0;

    const revenue = net - totals.orderDiscount * share;
    const cogs = Number(it.unitCost) * eq;
    const packagingCost = totals.packagingCost * share;
    const giftCost = totals.giftCost * share;
    const codFeeCost = totals.codFeeCost * share;
    const deliveryMargin = totals.deliveryMargin * share;

    out.set(it.id, {
      keptUnits: eq,
      returnedUnits: it.returns.reduce((s, r) => s + r.quantity, 0),
      revenue,
      cogs,
      share,
      packagingCost,
      giftCost,
      codFeeCost,
      deliveryMargin,
      netProfit: revenue - cogs - packagingCost - giftCost - codFeeCost + deliveryMargin,
    });
  }
  return out;
}

/** `range: null` means all time — no date filter at all. */
export async function buildProductReport(
  workspaceId: string,
  productId: string,
  range: DateRange | null,
): Promise<ProductReport | null> {
  const product = await prisma.product.findFirst({
    where: { id: productId, workspaceId },
    include: { variants: { orderBy: { id: "asc" } } },
  });
  if (!product) return null;

  const variantIds = product.variants.map((v) => v.id);
  const dateWhere = range ? { date: { gte: range.from, lte: range.to } } : {};

  const [allOrders, purchases, adjustments, stockMap, gifts] = await Promise.all([
    // Every order containing this product — but with ALL of its items, since
    // allocating the order's costs needs the whole order's revenue, not just
    // this product's slice of it.
    variantIds.length
      ? prisma.order.findMany({
          where: {
            workspaceId,
            ...dateWhere,
            items: { some: { productVariantId: { in: variantIds } } },
          },
          include: {
            customer: { select: { id: true, name: true } },
            items: {
              include: {
                returns: true,
                productVariant: { select: { id: true, attributes: true } },
              },
            },
          },
          orderBy: { date: "desc" },
        })
      : Promise.resolve([]),
    variantIds.length
      ? prisma.purchase.findMany({
          where: { workspaceId, productVariantId: { in: variantIds }, ...dateWhere },
          include: {
            supplier: { select: { name: true } },
            productVariant: { select: { attributes: true } },
          },
          orderBy: { date: "desc" },
        })
      : Promise.resolve([]),
    variantIds.length
      ? prisma.stockAdjustment.findMany({
          where: { workspaceId, productVariantId: { in: variantIds }, ...dateWhere },
          include: { productVariant: { select: { attributes: true } } },
          orderBy: { date: "desc" },
        })
      : Promise.resolve([]),
    variantIds.length
      ? variantStockMap(workspaceId, variantIds)
      : Promise.resolve(new Map<string, number>()),
    // Given away free with an order: no revenue, but stock left and it cost
    // something. Reported on its own rather than folded into profit — the
    // gift's cost belongs to the order that gave it, not to this product.
    variantIds.length
      ? prisma.orderGift.findMany({
          where: {
            productVariantId: { in: variantIds },
            order: { workspaceId, status: { not: "CANCELLED" }, ...dateWhere },
          },
          select: { quantity: true, unitCost: true },
        })
      : Promise.resolve([]),
  ]);

  const variantLabel = new Map(
    product.variants.map((v) => [v.id, variantChip(v.attributes)] as const),
  );

  const perVariant = new Map<string, ProductVariantPerf>(
    product.variants.map((v) => [
      v.id,
      {
        variantId: v.id,
        label: variantChip(v.attributes),
        sku: v.sku,
        salePrice: v.salePrice != null ? Number(v.salePrice) : null,
        unitCost: v.unitCost != null ? Number(v.unitCost) : null,
        unitsSold: 0,
        unitsReturned: 0,
        revenue: 0,
        cogs: 0,
        grossMargin: 0,
        netProfit: 0,
        stock: stockMap.get(v.id) ?? 0,
      },
    ]),
  );

  const mine = new Set(variantIds);
  const sold = allOrders.filter((o) => o.status !== "CANCELLED");
  const cancelled = allOrders.filter((o) => o.status === "CANCELLED");

  let unitsSold = 0;
  let unitsReturned = 0;
  let revenue = 0;
  let cogs = 0;
  let packagingCost = 0;
  let giftCost = 0;
  let codFeeCost = 0;
  let deliveryMargin = 0;
  let refunds = 0;

  const orderRows: ProductOrderRow[] = [];
  const returnRows: ProductReturnRow[] = [];
  const seriesMap = new Map<string, { units: number; revenue: number; profit: number }>();

  for (const o of sold) {
    const lines = allocateOrderLines(o);

    let oUnits = 0;
    let oReturned = 0;
    let oRevenue = 0;
    let oCogs = 0;
    let oProfit = 0;
    const oVariants = new Set<string>();

    for (const it of o.items) {
      if (!mine.has(it.productVariantId)) continue;
      const line = lines.get(it.id)!;

      oUnits += line.keptUnits;
      oReturned += line.returnedUnits;
      oRevenue += line.revenue;
      oCogs += line.cogs;
      oProfit += line.netProfit;
      oVariants.add(variantLabel.get(it.productVariantId) ?? "—");

      packagingCost += line.packagingCost;
      giftCost += line.giftCost;
      codFeeCost += line.codFeeCost;
      deliveryMargin += line.deliveryMargin;

      const v = perVariant.get(it.productVariantId);
      if (v) {
        v.unitsSold += line.keptUnits;
        v.unitsReturned += line.returnedUnits;
        v.revenue += line.revenue;
        v.cogs += line.cogs;
        v.grossMargin += line.revenue - line.cogs;
        v.netProfit += line.netProfit;
      }

      for (const r of it.returns) {
        refunds += Number(r.refundAmount);
        returnRows.push({
          id: r.id,
          date: r.date.toISOString().slice(0, 10),
          orderId: o.id,
          variant: variantLabel.get(it.productVariantId) ?? "—",
          quantity: r.quantity,
          reason: r.reason,
          refundAmount: Number(r.refundAmount),
        });
      }
    }

    unitsSold += oUnits;
    unitsReturned += oReturned;
    revenue += oRevenue;
    cogs += oCogs;

    const day = o.date.toISOString().slice(0, 10);
    const s = seriesMap.get(day) ?? { units: 0, revenue: 0, profit: 0 };
    s.units += oUnits;
    s.revenue += oRevenue;
    s.profit += oProfit;
    seriesMap.set(day, s);

    orderRows.push({
      orderId: o.id,
      date: day,
      status: o.status,
      paymentStatus: o.paymentStatus,
      customerId: o.customer?.id ?? null,
      customer: o.customer?.name ?? null,
      source: o.source,
      variants: [...oVariants],
      units: oUnits,
      returned: oReturned,
      revenue: round2(oRevenue),
      cogs: round2(oCogs),
      netProfit: round2(oProfit),
      cancelled: false,
      cancelledCost: 0,
    });
  }

  // Cancelled orders: nothing sold and the stock came back, so they stay out
  // of units, revenue and the order count — but the packaging, gift and
  // courier return charge were spent. Split by ordered value, the only weight
  // a cancelled order has (its kept quantities are all zero by definition).
  let cancelledCost = 0;
  for (const o of cancelled) {
    const waste = cancelledOrderCost(o).total;
    const gross = o.items.reduce((s, it) => s + Number(it.unitPrice) * it.quantity, 0);
    let share = 0;
    let oUnits = 0;
    const oVariants = new Set<string>();
    for (const it of o.items) {
      if (!mine.has(it.productVariantId)) continue;
      oUnits += it.quantity;
      oVariants.add(variantLabel.get(it.productVariantId) ?? "—");
      share +=
        gross > 0
          ? (Number(it.unitPrice) * it.quantity) / gross
          : o.items.length > 0
            ? 1 / o.items.length
            : 0;
    }
    const mySharedCost = waste * share;
    cancelledCost += mySharedCost;

    orderRows.push({
      orderId: o.id,
      date: o.date.toISOString().slice(0, 10),
      status: o.status,
      paymentStatus: o.paymentStatus,
      customerId: o.customer?.id ?? null,
      customer: o.customer?.name ?? null,
      source: o.source,
      variants: [...oVariants],
      units: oUnits,
      returned: 0,
      revenue: 0,
      cogs: 0,
      netProfit: 0,
      cancelled: true,
      cancelledCost: round2(mySharedCost),
    });
  }

  orderRows.sort((a, b) => b.date.localeCompare(a.date));

  const grossMargin = revenue - cogs;
  const netProfit =
    grossMargin - packagingCost - giftCost - codFeeCost + deliveryMargin;

  const purchaseQty = purchases.reduce((s, p) => s + p.quantity, 0);
  const purchaseSpend = purchases.reduce((s, p) => s + Number(p.unitCost) * p.quantity, 0);

  const stockOnHand = [...perVariant.values()].reduce((s, v) => s + v.stock, 0);
  const stockValue = [...perVariant.values()].reduce(
    (s, v) => s + Math.max(0, v.stock) * (v.unitCost ?? 0),
    0,
  );

  const giftedUnits = gifts.reduce((s, g) => s + g.quantity, 0);
  const giftedCost = gifts.reduce((s, g) => s + Number(g.unitCost) * g.quantity, 0);

  return {
    product: {
      id: product.id,
      name: product.name,
      category: product.category,
      sku: product.sku,
      barcode: product.barcode,
      imageUrl: product.imageUrl,
      unitsPerPack: product.unitsPerPack,
      lowStockThreshold: product.lowStockThreshold,
    },
    totals: {
      unitsSold,
      unitsReturned,
      orders: sold.length,
      revenue: round2(revenue),
      cogs: round2(cogs),
      grossMargin: round2(grossMargin),
      packagingCost: round2(packagingCost),
      giftCost: round2(giftCost),
      codFeeCost: round2(codFeeCost),
      deliveryMargin: round2(deliveryMargin),
      netProfit: round2(netProfit),
      refunds: round2(refunds),
      cancelledOrders: cancelled.length,
      cancelledCost: round2(cancelledCost),
      netProfitAfterCancellations: round2(netProfit - cancelledCost),
      avgSellPrice: unitsSold > 0 ? round2(revenue / unitsSold) : 0,
      avgUnitCost: unitsSold > 0 ? round2(cogs / unitsSold) : 0,
      marginPercent: revenue > 0 ? round2((netProfit / revenue) * 100) : null,
      giftedUnits,
      giftedCost: round2(giftedCost),
    },
    stock: { onHand: stockOnHand, value: round2(stockValue) },
    purchases: {
      quantity: purchaseQty,
      spend: round2(purchaseSpend),
      rows: purchases.map((p) => ({
        id: p.id,
        date: p.date.toISOString().slice(0, 10),
        supplier: p.supplier?.name ?? null,
        variant: variantChip(p.productVariant.attributes),
        quantity: p.quantity,
        unitCost: Number(p.unitCost),
        total: round2(Number(p.unitCost) * p.quantity),
        expiryDate: p.expiryDate ? p.expiryDate.toISOString().slice(0, 10) : null,
      })),
    },
    variants: [...perVariant.values()]
      .map((v) => ({
        ...v,
        revenue: round2(v.revenue),
        cogs: round2(v.cogs),
        grossMargin: round2(v.grossMargin),
        netProfit: round2(v.netProfit),
      }))
      .sort((a, b) => b.unitsSold - a.unitsSold),
    orders: orderRows,
    returns: returnRows.sort((a, b) => b.date.localeCompare(a.date)),
    adjustments: adjustments.map((a) => ({
      id: a.id,
      date: a.date.toISOString().slice(0, 10),
      variant: variantChip(a.productVariant.attributes),
      type: a.type,
      delta: a.delta,
      reason: a.reason,
    })),
    series: [...seriesMap.entries()]
      .map(([date, v]) => ({
        date,
        units: v.units,
        revenue: round2(v.revenue),
        profit: round2(v.profit),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}
