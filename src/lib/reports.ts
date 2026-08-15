import { prisma } from "@/lib/prisma";
import { cancelledOrderCost, computeOrderTotals } from "@/lib/orders";
import { allocateOrderLines } from "@/lib/product-report";
import { amountCollected } from "@/lib/order-cash";
import { splitByShare } from "@/lib/profit-share";
import { dhakaDayEnd, dhakaDayKey, dhakaDayStart, dhakaDaysAgo, dhakaToday } from "@/lib/dhaka-time";
import { operatingExpenses } from "@/lib/finance";

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export type DateRange = { from: Date; to: Date };

/**
 * Last 30 days, inclusive, on Dhaka calendar days.
 *
 * These used to be built with setHours(), which anchors to the *server's*
 * midnight — UTC on Vercel. A range someone picked as "1 Aug to 31 Aug"
 * actually covered 1 Aug 06:00 to 1 Sep 05:59 Dhaka time, so orders taken late
 * on the last day of a month landed in the next one.
 */
export function defaultRange(): DateRange {
  return { from: dhakaDayStart(dhakaDaysAgo(29)), to: dhakaDayEnd(dhakaToday()) };
}

/** Parse ?from=YYYY-MM-DD&to=YYYY-MM-DD as Dhaka days, or the default range. */
export function parseRange(fromStr?: string, toStr?: string): DateRange {
  const def = defaultRange();
  const from = fromStr ? dhakaDayStart(fromStr) : def.from;
  const to = toStr ? dhakaDayEnd(toStr) : def.to;
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
    internalPurchaseSpend: number;
    miscExpense: number;
    /** Stock written off as damaged or lost, at what it cost to buy. */
    stockLoss: number;
    /** Spread costs paid for but not yet charged to any period. */
    prepaidExpenses: number;
    /** adSpend + internalPurchaseSpend + miscExpense + stockLoss. */
    operatingExpenses: number;
    /** profit − operatingExpenses. What partner shares are paid on. */
    netProfit: number;
    profitAfterAds: number;
    /** Cancelled orders in range, and the packaging/gift/courier they burned. */
    cancelledOrders: number;
    cancelledCost: number;
  };
  series: { date: string; sales: number; profit: number }[];
  products: ProductPerf[]; // all products, sorted by qty desc
  // `percent` is what the partner's record says; `effectivePercent` is what
  // they're actually paid on once shares are normalized to their own total.
  partnerShares: { name: string; percent: number; effectivePercent: number; amount: number }[];
  // Money actually collected — a settled order in full, a part-paid one for
  // its advance — grouped by how the customer paid. Sorted by amount desc.
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

  // Sums to the same profit the KPI shows, so a reader can add the product
  // table up and land on the header figure. Sold orders only — a cancelled one
  // has no lines to split, and its cost is allocated separately below.
  const allocations = new Map(orders.map((o) => [o.id, allocateOrderLines(o)]));

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

    const day = dhakaDayKey(o.date);
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

    // What has actually come in, which now includes an advance on a part-paid
    // order — money the shop is holding, and previously counted nowhere.
    const collected = amountCollected(o, t);
    if (collected > 0) {
      const m = methodMap.get(o.paymentMethod) ?? { amount: 0, orders: 0 };
      m.amount += collected;
      m.orders += 1;
      methodMap.set(o.paymentMethod, m);
    }

    // Per-line revenue and profit come from the same allocation the product
    // pages use, not from price − cost. That shortcut ignored every discount
    // and every order-level cost, so the product table claimed a margin the
    // KPI above it disagreed with — on a 1,000 order with 100 off, by exactly
    // the 100 nobody could find.
    const lines = allocations.get(o.id);
    for (const it of o.items) {
      const alloc = lines?.get(it.id);
      if (!alloc || alloc.keptUnits === 0) continue;
      const pid = it.productVariant.product.id;
      const a =
        productMap.get(pid) ??
        { productId: pid, name: it.productVariant.product.name, qty: 0, revenue: 0, profit: 0 };
      a.qty += alloc.keptUnits;
      a.revenue += alloc.revenue;
      a.profit += alloc.netProfit;
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

    const day = dhakaDayKey(o.date);
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

  // Everything it costs to run the shop over the same range, so the report can
  // say what was left rather than what was taken. Ad spend was already here;
  // the other two were not, and partner shares were calculated from a profit
  // figure that had paid for neither.
  //
  // Through operatingExpenses, which the lifetime rollup and the dashboard
  // tile also call. This page had the whole list and the dashboard had one
  // quarter of it, and neither could see the other to disagree with it.
  const [expenses, partners] = await Promise.all([
    operatingExpenses(workspaceId, range),
    prisma.partner.findMany({
      where: { workspaceId },
      include: { user: { select: { name: true, email: true } } },
    }),
  ]);
  const { adSpend, internalPurchaseSpend, miscExpense, stockLoss } = expenses;
  const netProfit = round2(profit - expenses.total);

  // splitByShare, not a raw percentage — the same function a distribution pays
  // out with, so this table and the payout can't give different answers.
  const partnerShares = splitByShare(
    partners.map((p) => ({
      name: p.user.name ?? p.user.email,
      percent: Number(p.profitSharePercent),
    })),
    netProfit,
  ).map((c) => ({
    name: c.name,
    percent: c.percent,
    effectivePercent: c.effectivePercent,
    amount: c.amount,
  }));

  return {
    kpis: {
      revenue: round2(revenue),
      profit: round2(profit),
      orders: orders.length,
      avgOrder: orders.length ? round2(revenue / orders.length) : 0,
      adSpend,
      internalPurchaseSpend,
      miscExpense,
      stockLoss,
      prepaidExpenses: expenses.prepaidExpenses,
      operatingExpenses: expenses.total,
      netProfit,
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
