import { prisma } from "@/lib/prisma";
import { cancelledOrderCost, computeOrderTotals } from "@/lib/orders";

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export type DateRange = { from: Date; to: Date };

export function defaultRange(): DateRange {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 29); // last 30 days inclusive
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/** Parse ?from=YYYY-MM-DD&to=YYYY-MM-DD, falling back to the default range. */
export function parseRange(fromStr?: string, toStr?: string): DateRange {
  const def = defaultRange();
  const from = fromStr ? new Date(fromStr + "T00:00:00") : def.from;
  const to = toStr ? new Date(toStr + "T23:59:59") : def.to;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return def;
  return { from, to };
}

export type ProductPerf = {
  productId: string;
  name: string;
  qty: number;
  revenue: number;
  profit: number;
};

export type PaymentMethodTotal = { method: string; amount: number; orders: number };

/** Where orders came from. `source` is null for anything never tagged. */
export type SourceTotal = {
  source: string | null;
  orders: number;
  revenue: number;
  profit: number;
  /** Cancelled orders from this channel, and what they still cost. */
  cancelledOrders: number;
  cancelledCost: number;
  /** Cancelled ÷ (sold + cancelled). Null when the channel has no orders. */
  cancelRate: number | null;
};

export type Report = {
  kpis: {
    revenue: number;
    profit: number;
    orders: number;
    avgOrder: number;
    adSpend: number;
    profitAfterAds: number;
    /** Cancelled orders in range, and the packaging/gift/courier they burned. */
    cancelledOrders: number;
    cancelledCost: number;
  };
  series: { date: string; sales: number; profit: number }[];
  products: ProductPerf[]; // all products, sorted by qty desc
  partnerShares: { name: string; percent: number; amount: number }[];
  // Money actually collected (paymentStatus PAID only — UNPAID/PARTIAL isn't
  // "collected" yet), grouped by how the customer paid. Sorted by amount desc.
  collectedByMethod: PaymentMethodTotal[];
  // Which channel the orders came from — count, revenue and profit each.
  // Cancelled orders are already excluded upstream, so this counts real sales.
  bySource: SourceTotal[];
};

/** `range: null` means "all time" — no date filter at all. */
export async function buildReport(
  workspaceId: string,
  range: DateRange | null,
): Promise<Report> {
  // Cancelled orders are fetched too, then split out below. They sell nothing
  // and their stock goes back, but the packaging, gift and courier return
  // charge are real money — filtering them out at the query, as this used to,
  // made that loss invisible rather than zero.
  const allOrders = await prisma.order.findMany({
    where: {
      workspaceId,
      ...(range ? { date: { gte: range.from, lte: range.to } } : {}),
    },
    include: {
      items: {
        include: {
          returns: true,
          productVariant: { select: { product: { select: { id: true, name: true } } } },
        },
      },
    },
    orderBy: { date: "asc" },
  });

  const orders = allOrders.filter((o) => o.status !== "CANCELLED");
  const cancelled = allOrders.filter((o) => o.status === "CANCELLED");

  let revenue = 0;
  let profit = 0;
  const seriesMap = new Map<string, { sales: number; profit: number }>();
  const productMap = new Map<string, ProductPerf>();
  const methodMap = new Map<string, { amount: number; orders: number }>();
  const sourceMap = new Map<
    string,
    { orders: number; revenue: number; profit: number; cancelledOrders: number; cancelledCost: number }
  >();
  const blankSource = () => ({
    orders: 0,
    revenue: 0,
    profit: 0,
    cancelledOrders: 0,
    cancelledCost: 0,
  });

  for (const o of orders) {
    const t = computeOrderTotals(o);
    revenue += t.netRevenue;
    profit += t.netProfit;

    const day = o.date.toISOString().slice(0, 10);
    const s = seriesMap.get(day) ?? { sales: 0, profit: 0 };
    s.sales += t.netRevenue;
    s.profit += t.netProfit;
    seriesMap.set(day, s);

    const srcKey = o.source ?? "";
    const src = sourceMap.get(srcKey) ?? blankSource();
    src.orders += 1;
    src.revenue += t.netRevenue;
    src.profit += t.netProfit;
    sourceMap.set(srcKey, src);

    if (o.paymentStatus === "PAID") {
      const m = methodMap.get(o.paymentMethod) ?? { amount: 0, orders: 0 };
      m.amount += t.customerTotal;
      m.orders += 1;
      methodMap.set(o.paymentMethod, m);
    }

    for (const it of o.items) {
      const returned = it.returns.reduce((a, r) => a + r.quantity, 0);
      const eq = Math.max(0, it.quantity - returned);
      if (eq === 0) continue;
      const pid = it.productVariant.product.id;
      const a =
        productMap.get(pid) ??
        { productId: pid, name: it.productVariant.product.name, qty: 0, revenue: 0, profit: 0 };
      a.qty += eq;
      a.revenue += Number(it.unitPrice) * eq;
      a.profit += (Number(it.unitPrice) - Number(it.unitCost)) * eq;
      productMap.set(pid, a);
    }
  }

  // A cancelled order costs money without selling anything, so it lands in
  // profit and in its channel's row, but never in revenue, the order count or
  // the product tables — nothing was sold and the stock went back.
  let cancelledCost = 0;
  for (const o of cancelled) {
    const cost = cancelledOrderCost(o).total;
    cancelledCost += cost;
    profit -= cost;

    const day = o.date.toISOString().slice(0, 10);
    const s = seriesMap.get(day) ?? { sales: 0, profit: 0 };
    s.profit -= cost;
    seriesMap.set(day, s);

    const srcKey = o.source ?? "";
    const src = sourceMap.get(srcKey) ?? blankSource();
    src.cancelledOrders += 1;
    src.cancelledCost += cost;
    src.profit -= cost;
    sourceMap.set(srcKey, src);
  }

  // Include products with zero sales in range so slow-movers surface.
  const allProducts = await prisma.product.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
  });
  for (const p of allProducts) {
    if (!productMap.has(p.id)) {
      productMap.set(p.id, { productId: p.id, name: p.name, qty: 0, revenue: 0, profit: 0 });
    }
  }

  const series = [...seriesMap.entries()]
    .map(([date, v]) => ({ date, sales: round2(v.sales), profit: round2(v.profit) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const products = [...productMap.values()]
    .map((p) => ({ ...p, revenue: round2(p.revenue), profit: round2(p.profit) }))
    .sort((a, b) => b.qty - a.qty);

  const collectedByMethod = [...methodMap.entries()]
    .map(([method, v]) => ({ method, amount: round2(v.amount), orders: v.orders }))
    .sort((a, b) => b.amount - a.amount);

  // Boosting (ad) spend inside the range — shown alongside order profit so the
  // report reflects what marketing actually cost.
  const adSpendAgg = await prisma.boostDailySpend.aggregate({
    _sum: { amount: true },
    where: { workspaceId, ...(range ? { date: { gte: range.from, lte: range.to } } : {}) },
  });
  const adSpend = round2(Number(adSpendAgg._sum.amount ?? 0));

  const partners = await prisma.partner.findMany({
    where: { workspaceId },
    include: { user: { select: { name: true, email: true } } },
  });
  const partnerShares = partners.map((p) => {
    const percent = Number(p.profitSharePercent);
    return {
      name: p.user.name ?? p.user.email,
      percent,
      amount: round2((percent / 100) * profit),
    };
  });

  return {
    kpis: {
      revenue: round2(revenue),
      profit: round2(profit),
      orders: orders.length,
      avgOrder: orders.length ? round2(revenue / orders.length) : 0,
      adSpend,
      profitAfterAds: round2(profit - adSpend),
      cancelledOrders: cancelled.length,
      cancelledCost: round2(cancelledCost),
    },
    series,
    products,
    partnerShares,
    collectedByMethod,
    // Biggest channel first; untagged orders sort last however large, because
    // "Not set" is a gap to close rather than a channel to celebrate.
    bySource: [...sourceMap.entries()]
      .map(([source, v]) => ({
        source: source || null,
        orders: v.orders,
        revenue: round2(v.revenue),
        profit: round2(v.profit),
        cancelledOrders: v.cancelledOrders,
        cancelledCost: round2(v.cancelledCost),
        // Out of everything this channel produced, not just what stuck — a
        // channel that sends 10 orders and loses 5 is 50%, not 100%.
        cancelRate:
          v.orders + v.cancelledOrders > 0
            ? v.cancelledOrders / (v.orders + v.cancelledOrders)
            : null,
      }))
      .sort((a, b) => {
        if (!a.source !== !b.source) return a.source ? -1 : 1;
        return b.revenue - a.revenue;
      }),
  };
}
