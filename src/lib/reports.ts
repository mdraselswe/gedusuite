import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";

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

export type Report = {
  kpis: { revenue: number; profit: number; orders: number; avgOrder: number };
  series: { date: string; sales: number; profit: number }[];
  products: ProductPerf[]; // all products, sorted by qty desc
  partnerShares: { name: string; percent: number; amount: number }[];
};

export async function buildReport(
  workspaceId: string,
  range: DateRange,
): Promise<Report> {
  const orders = await prisma.order.findMany({
    where: {
      workspaceId,
      status: { not: "CANCELLED" },
      date: { gte: range.from, lte: range.to },
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

  let revenue = 0;
  let profit = 0;
  const seriesMap = new Map<string, { sales: number; profit: number }>();
  const productMap = new Map<string, ProductPerf>();

  for (const o of orders) {
    const t = computeOrderTotals(o);
    revenue += t.netRevenue;
    profit += t.netProfit;

    const day = o.date.toISOString().slice(0, 10);
    const s = seriesMap.get(day) ?? { sales: 0, profit: 0 };
    s.sales += t.netRevenue;
    s.profit += t.netProfit;
    seriesMap.set(day, s);

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
    },
    series,
    products,
    partnerShares,
  };
}
