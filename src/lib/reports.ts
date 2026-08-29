import { prisma } from "@/lib/prisma";
import { cancelledOrderCost, computeOrderTotals } from "@/lib/orders";
import { allocateOrderLines } from "@/lib/product-report";
import { amountCollected } from "@/lib/order-cash";
import { splitByShare } from "@/lib/profit-share";
import { dhakaDayEnd, dhakaDayKey, dhakaDayStart, dhakaDaysAgo, dhakaToday } from "@/lib/dhaka-time";
import { operatingExpenses } from "@/lib/finance";
import { round2 } from "@/lib/money";


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

/**
 * What a combo actually did.
 *
 * Built from the component lines it was saved as, using the same per-line
 * allocation the product table uses — so a combo's revenue and profit are on
 * the same footing as everything else in this report and can be added to it
 * without double-counting. `sets` counts distinct comboKeys, which is the only
 * thing that can tell two of the same combo apart once their components have
 * been merged.
 */
export type ComboPerf = {
  comboSetId: string;
  name: string;
  /** Complete sets sold. */
  sets: number;
  /** Pieces those sets contained, net of returns. */
  units: number;
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

/**
 * How parcels to one district ended up.
 *
 * `district` is Order.shipDistrict — best-effort and often null, so untagged
 * orders get their own row rather than being dropped. See the column's note in
 * schema.prisma for where the tag comes from.
 *
 * Note the denominator is NOT the one bySource uses. A channel is judged on
 * everything it produced, including orders still in flight — they are already
 * its work. A district is judged on parcels that reached a verdict: one still
 * travelling has not had its chance to be refused, and counting it as a
 * success makes every district look better the more parcels are in transit.
 * Both counts are exposed so either question can be asked of the same row.
 */
export type DistrictTotal = {
  /** null = this parcel's district was never tagged. */
  district: string | null;
  /** Every order to this district, cancellations included. */
  orders: number;
  delivered: number;
  cancelled: number;
  /** Neither delivered nor cancelled yet — no verdict to count. */
  inFlight: number;
  revenue: number;
  cancelledCost: number;
  /** cancelled ÷ (delivered + cancelled). Null until something settles. */
  cancelRate: number | null;
};

/**
 * Where the goods went on the cancellations in range — counted by parcel, not
 * by piece, because that is the unit a courier is answerable for.
 *
 * `sentBack` deliberately excludes cancellations whose goods never left (never
 * packed, or handed back at the door): there was no return leg to succeed or
 * fail at, and counting them would flatter the rate.
 */
export type ReturnLegSummary = {
  /** Cancelled parcels that had a return leg at all. */
  sentBack: number;
  /** Still travelling — no verdict yet either way. */
  stillOut: number;
  /** Booked back in. */
  received: number;
  /** Written off: the courier never brought it back. */
  lost: number;
  /**
   * What the goods on those lost parcels cost, from the same cost snapshot the
   * profit math uses.
   *
   * Reported, not subtracted. Writing a parcel off already created the LOST
   * stock adjustments that `stockLoss` is built from, so taking it off profit
   * here would charge the shop twice for one loss.
   */
  lostCost: number;
  /** lost ÷ (received + lost). Null until something has settled either way. */
  lossRate: number | null;
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
  /**
   * How the goods on those cancelled orders got home — the courier's side of a
   * cancellation, which the money figures above say nothing about.
   *
   * A cancellation costs the return charge whether or not the parcel turns up.
   * Whether it turns up is a different question, and one nobody could ask
   * before: a parcel that was never brought back simply stayed on the shelf as
   * stock that had not been there for months.
   */
  returns: ReturnLegSummary;
  series: { date: string; sales: number; profit: number }[];
  products: ProductPerf[]; // all products, sorted by qty desc
  // Combos that sold in range, best-selling first. Empty when the shop sells
  // none — the report then leaves the section out entirely.
  combos: ComboPerf[];
  // `percent` is what the partner's record says; `effectivePercent` is what
  // they're actually paid on once shares are normalized to their own total.
  partnerShares: { name: string; percent: number; effectivePercent: number; amount: number }[];
  // Money actually collected — a settled order in full, a part-paid one for
  // its advance — grouped by how the customer paid. Sorted by amount desc.
  collectedByMethod: PaymentMethodTotal[];
  // Which channel the orders came from — count, revenue and profit each.
  // Cancelled orders are already excluded upstream, so this counts real sales.
  bySource: SourceTotal[];
  // Where the parcels went, and how many came back. Biggest first, untagged
  // last.
  byDistrict: DistrictTotal[];
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
  // Names for the combo table. Fetched separately because an order line keeps
  // only the recipe's id — deliberately, so deleting a combo cannot delete the
  // history of what it sold. A combo since deleted still reports, unnamed.
  const comboSets = await prisma.comboSet.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
  });
  const comboNames = new Map(comboSets.map((c) => [c.id, c.name]));
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
  const comboMap = new Map<string, ComboPerf>();
  /** comboSetId -> the set instances seen, so two of one combo count as two. */
  const comboKeys = new Map<string, Set<string>>();
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
  const districtMap = new Map<
    string,
    { delivered: number; cancelled: number; inFlight: number; revenue: number; cancelledCost: number }
  >();
  const blankDistrict = () => ({
    delivered: 0,
    cancelled: 0,
    inFlight: 0,
    revenue: 0,
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

    const dstKey = o.shipDistrict ?? "";
    const dst = districtMap.get(dstKey) ?? blankDistrict();
    // DELIVERED is the only status that settles a parcel in the shop's favour.
    // Everything else here — pending, packed, shipped — is still moving.
    if (o.status === "DELIVERED") dst.delivered += 1;
    else dst.inFlight += 1;
    dst.revenue += t.netRevenue;
    districtMap.set(dstKey, dst);

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

      // The same line, counted a second time under the combo it came out of.
      // Not a double-count of the report's totals: this is a separate table
      // answering "which of my combos is worth keeping", and a combo's pieces
      // are genuinely also products.
      if (it.comboSetId) {
        const c =
          comboMap.get(it.comboSetId) ??
          {
            comboSetId: it.comboSetId,
            name: comboNames.get(it.comboSetId) ?? "Deleted combo",
            sets: 0,
            units: 0,
            revenue: 0,
            profit: 0,
          };
        c.units += alloc.keptUnits;
        c.revenue += alloc.revenue;
        c.profit += alloc.netProfit;
        comboMap.set(it.comboSetId, c);
        if (it.comboKey) {
          const seen = comboKeys.get(it.comboSetId) ?? new Set<string>();
          seen.add(it.comboKey);
          comboKeys.set(it.comboSetId, seen);
        }
      }
    }
  }
  for (const [id, c] of comboMap) c.sets = comboKeys.get(id)?.size ?? 0;

  // A cancelled order costs money without selling anything, so it lands in
  // profit and in its channel's row, but never in revenue, the order count or
  // the product tables — nothing was sold and the stock went back.
  let cancelledCost = 0;
  const legs: ReturnLegSummary = {
    sentBack: 0,
    stillOut: 0,
    received: 0,
    lost: 0,
    lostCost: 0,
    lossRate: null,
  };
  for (const o of cancelled) {
    const cost = cancelledOrderCost(o).total;
    cancelledCost += cost;
    profit -= cost;

    // NONE means the goods never left, so there is no leg to report on.
    if (o.returnLeg !== "NONE") {
      legs.sentBack += 1;
      if (o.returnLeg === "IN_TRANSIT") legs.stillOut += 1;
      if (o.returnLeg === "RECEIVED") legs.received += 1;
      if (o.returnLeg === "LOST") {
        legs.lost += 1;
        // The cost snapshot on the line, not today's price — this is what the
        // shop paid for the pieces that never came home.
        legs.lostCost += o.items.reduce((s, it) => s + Number(it.unitCost) * it.quantity, 0);
      }
    }

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

    const dstKey = o.shipDistrict ?? "";
    const dst = districtMap.get(dstKey) ?? blankDistrict();
    dst.cancelled += 1;
    dst.cancelledCost += cost;
    districtMap.set(dstKey, dst);
  }
  // Out of the parcels that have an answer. A hundred still in transit say
  // nothing about how often this courier loses one.
  const settledLegs = legs.received + legs.lost;
  legs.lostCost = round2(legs.lostCost);
  legs.lossRate = settledLegs > 0 ? legs.lost / settledLegs : null;

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

  const combos = [...comboMap.values()]
    .map((c) => ({ ...c, revenue: round2(c.revenue), profit: round2(c.profit) }))
    .sort((a, b) => b.sets - a.sets);

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
    returns: legs,
    series,
    products,
    combos,
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
    // Most parcels first — a district's cancel rate is only worth reading next
    // to the volume it is a rate of, and sorting by rate would put a district
    // with one refused parcel above everywhere the shop actually ships to.
    // Untagged sorts last for the same reason "Not set" does above.
    byDistrict: [...districtMap.entries()]
      .map(([district, v]) => {
        const settled = v.delivered + v.cancelled;
        return {
          district: district || null,
          orders: v.delivered + v.cancelled + v.inFlight,
          delivered: v.delivered,
          cancelled: v.cancelled,
          inFlight: v.inFlight,
          revenue: round2(v.revenue),
          cancelledCost: round2(v.cancelledCost),
          cancelRate: settled > 0 ? v.cancelled / settled : null,
        };
      })
      .sort((a, b) => {
        if (!a.district !== !b.district) return a.district ? -1 : 1;
        return b.orders - a.orders;
      }),
  };
}
